import crypto from 'node:crypto';
import {
  SessionsRepo,
  TurnsRepo,
  MessagesRepo,
  BranchesRepo,
  nextCursorFor,
  type SessionRow,
  type SessionRowEnriched,
  type SessionSearchRow,
  type TurnRow,
  type MessageRow,
} from '@ema-agent/storage';
import {
  type SessionId,
  type TurnId,
  type MessageId,
  type BranchId,
  type CharacterCardId,
  type TurnMode,
  type AgentSubMode,
  type MessageBlocks,
  asSessionId,
  asTurnId,
  asMessageId,
  asBranchId,
} from '@ema-agent/contracts';
import type { Database } from '@ema-agent/storage';
import { RunRegistry } from './run-registry.js';
import { BranchAncestorTable } from './branch-ancestor.js';
import type {
  Session,
  Turn,
  Branch,
  BranchSibling,
  Message,
  CreateSessionInput,
  StartTurnInput,
  CompleteTurnInput,
  AppendMessageInput,
  ForkMessageInput,
  SwitchBranchInput,
  ListSessionsInput,
  ListSessionsOutput,
  ListMessagesInput,
  SearchSessionsInput,
  SearchSessionsOutput,
} from './types.js';

// ── Row → domain object converters (module-private) ──────────────────────────

function safeJson<T>(raw: string, fallback: T, label: string): T {
  try { return JSON.parse(raw) as T; }
  catch { console.warn(`[session] corrupt JSON in ${label}, using fallback`); return fallback; }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id as SessionId,
    title: row.title,
    characterCardId: row.character_card_id as CharacterCardId,
    workspaceRoots: safeJson(row.workspace_roots_json, [] as string[], `session ${row.id} workspace_roots_json`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at,
    pinned:        row.pinned === 1,
    pinnedAt:      row.pinned_at,
    groupLabel:    row.group_label,
    parentSessionId:  row.parent_session_id  as SessionId  | null,
    activeBranchId:   (row.active_branch_id ?? null) as BranchId | null,
    runningTurnCount: 0,    // populated by caller
    lastMode:    (row.last_mode    ?? null) as TurnMode    | null,
    lastSubMode: (row.last_sub_mode ?? null) as AgentSubMode | null,
    lastViewedAt:   row.last_viewed_at ?? null,
    lastTurnStatus: null,
    hasUnread:      false,
  };
}

function toSessionEnriched(row: SessionRowEnriched): Session {
  const s = toSession(row);
  const lastTurnStatus = (row.last_turn_status ?? null) as Session['lastTurnStatus'];
  const lastTurnCompletedAt = row.last_turn_completed_at ?? 0;
  const hasUnread = lastTurnStatus === 'completed'
    && lastTurnCompletedAt > (row.last_viewed_at ?? 0);
  return { ...s, lastTurnStatus, hasUnread };
}

function toTurn(row: TurnRow): Turn {
  return {
    id:           row.id        as TurnId,
    sessionId:    row.session_id as SessionId,
    branchId:     (row.branch_id ?? null) as BranchId | null,
    mode:         row.mode,
    agentSubMode: row.agent_sub_mode,
    status: row.status,
    userInput: row.user_input,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    iterations: row.iterations,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
    costUsd: row.cost_usd,
  };
}

function toMessage(row: MessageRow): Message {
  let blocks: MessageBlocks;
  try {
    blocks = JSON.parse(row.blocks_json) as MessageBlocks;
  } catch {
    // Fallback: treat malformed JSON as a plain string (defensive)
    blocks = row.blocks_json;
  }
  return {
    id:          row.id as MessageId,
    sessionId:   row.session_id as SessionId,
    turnId:      row.turn_id as TurnId | null,
    role:        row.role,
    kind:        row.kind,
    blocks,
    interrupted: row.interrupted === 1,
    createdAt:   row.created_at,
  };
}

function blocksJsonToSearchText(raw: string | null): string {
  if (!raw) return '';
  try {
    const blocks = JSON.parse(raw) as MessageBlocks;
    if (typeof blocks === 'string') return normaliseSnippet(blocks);
    if (!Array.isArray(blocks)) return '';

    const parts: string[] = [];
    for (const b of blocks as Array<{ type?: string; text?: string; content?: unknown }>) {
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      } else if (b.type === 'tool_result' && typeof b.content === 'string') {
        parts.push(b.content);
      }
    }
    return normaliseSnippet(parts.join(' '));
  } catch {
    return normaliseSnippet(raw);
  }
}

function normaliseSnippet(text: string): string {
  return text
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function toSearchHit(row: SessionSearchRow): SearchSessionsOutput['results'][number] {
  const session = toSessionEnriched(row);
  return {
    session,
    matchKind: row.match_kind,
    snippet: row.match_kind === 'title'
      ? row.title
      : blocksJsonToSearchText(row.snippet_json),
    messageId: row.message_id as MessageId | null,
    messageAt: row.message_created_at,
  };
}

// ── SessionStore ──────────────────────────────────────────────────────────────

export interface SessionStoreDeps {
  db: Database;
}

/**
 * SessionStore — single Façade for all session/turn/message state.
 *
 * Concurrency contract:
 *   One session allows at most ONE running turn at a time.
 *   startTurn() enforces this via RunRegistry (in-memory) + DB heal on startup.
 *   Multiple sessions can have concurrent running turns independently.
 */
export class SessionStore {
  private readonly sessionsRepo: SessionsRepo;
  private readonly turnsRepo:    TurnsRepo;
  private readonly messagesRepo: MessagesRepo;
  private readonly branchesRepo: BranchesRepo;
  private readonly registry:     RunRegistry;
  /** Monotonically increasing clock — ensures created_at is unique even for sub-ms bursts. */
  private lastTs = 0;

  constructor({ db }: SessionStoreDeps) {
    this.sessionsRepo = new SessionsRepo(db.sqlite);
    this.turnsRepo    = new TurnsRepo(db.sqlite);
    this.messagesRepo = new MessagesRepo(db.sqlite);
    this.branchesRepo = new BranchesRepo(db.sqlite);
    this.registry     = new RunRegistry();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Returns a timestamp that is guaranteed to be strictly greater than the
   * last one returned from this instance. Prevents cursor-pagination breakage
   * when multiple records are inserted in the same millisecond.
   */
  private nextTs(): number {
    const now = Date.now();
    this.lastTs = now > this.lastTs ? now : this.lastTs + 1;
    return this.lastTs;
  }

  // ── Session ─────────────────────────────────────────────────────────────────

  createSession(input: CreateSessionInput = {}): Session {
    const id  = asSessionId(crypto.randomUUID());
    const now = this.nextTs();
    const title = (input.title?.trim() || '新对话');
    this.sessionsRepo.insert({
      id,
      title,
      characterCardId:  input.characterCardId  ?? ('ema' as CharacterCardId),
      workspaceRoots:   input.workspaceRoots,
      parentSessionId:  input.parentSessionId,
      createdAt:        now,
      updatedAt:        now,
      lastActivityAt:   now,
    });
    return this.requireSession(id);
  }

  getSession(id: SessionId): Session {
    return this.requireSession(id);
  }

  /** Non-throwing existence check. Used to guard turn creation against stale
   *  client session ids (e.g. a viewedSessionId left over from a wiped DB). */
  sessionExists(id: SessionId): boolean {
    return this.sessionsRepo.findById(id) !== undefined;
  }

  listSessions(input: ListSessionsInput = {}): ListSessionsOutput {
    const limit = input.limit ?? 50;
    // Fetch one extra row to know if there's a next page
    const rows = this.sessionsRepo.listActive(limit + 1, input.cursor);
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const sessions = visible.map(r => {
      const s = toSession(r);
      s.runningTurnCount = this.sessionsRepo.runningTurnCount(s.id);
      return s;
    });
    const nextCursor = hasMore
      ? nextCursorFor(visible[visible.length - 1]!)
      : undefined;
    return { sessions, nextCursor };
  }

  /** Grouped listing for sidebar UI. */
  listSessionsGrouped(): {
    pinned:   Session[];
    byGroup:  Array<{ label: string; sessions: Session[] }>;
    recent:   Session[];
    archived: Session[];
  } {
    const grouped = this.sessionsRepo.listGrouped();
    const map = (rows: SessionRowEnriched[]) => rows.map(r => {
      const s = toSessionEnriched(r);
      s.runningTurnCount = this.sessionsRepo.runningTurnCount(s.id);
      return s;
    });
    return {
      pinned:   map(grouped.pinned),
      byGroup:  grouped.byGroup.map(g => ({ label: g.label, sessions: map(g.sessions) })),
      recent:   map(grouped.recent),
      archived: map(grouped.archived),
    };
  }

  searchSessions(input: SearchSessionsInput): SearchSessionsOutput {
    const query = input.query.trim();
    if (!query) return { results: [] };
    const rows = this.sessionsRepo.search(query, input.limit ?? 20);
    const results = rows.map((r) => {
      const hit = toSearchHit(r);
      hit.session.runningTurnCount = this.sessionsRepo.runningTurnCount(hit.session.id);
      return hit;
    });
    return { results };
  }

  setViewedAt(id: SessionId): void {
    this.sessionsRepo.setViewedAt(id, Date.now());
  }

  updateTitle(id: SessionId, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) return;   // empty → no-op, keep current title
    this.sessionsRepo.updateTitle(id, trimmed, Date.now());
  }

  /**
   * Apply a partial session update atomically. All listed fields move in one
   * SQLite transaction — if any sub-update would fail the whole patch rolls
   * back, leaving the row untouched.
   *
   * Use this from `PUT /api/sessions/:id` instead of calling
   * `updateTitle` + `pinSession` + `setSessionGroup` separately (those are
   * three independent transactions and can leave half-applied state).
   *
   * `groupLabel === null` is the explicit "move out of group" signal.
   * `groupLabel === undefined` leaves the existing group untouched.
   * Empty-string title is silently dropped (no rename).
   */
  patchSession(
    id: SessionId,
    patch: {
      title?:          string;
      pinned?:         boolean;
      groupLabel?:     string | null;
      workspaceRoots?: string[];
      lastMode?:       TurnMode | null;
      lastSubMode?:    AgentSubMode | null;
    },
  ): void {
    const cleaned: Parameters<SessionsRepo['patch']>[1] = {};

    if (patch.title !== undefined) {
      const trimmed = patch.title.trim();
      if (trimmed) cleaned.title = trimmed;
    }
    if (patch.pinned !== undefined)     cleaned.pinned     = patch.pinned;
    if (patch.groupLabel !== undefined) {
      const normalised = patch.groupLabel === null
        ? null
        : patch.groupLabel.trim() || null;
      cleaned.groupLabel = normalised;
    }
    if (patch.workspaceRoots !== undefined) {
      cleaned.workspaceRoots = patch.workspaceRoots;
    }
    if (patch.lastMode !== undefined)    cleaned.lastMode    = patch.lastMode;
    if (patch.lastSubMode !== undefined) cleaned.lastSubMode = patch.lastSubMode;

    if (Object.keys(cleaned).length === 0) return;

    this.sessionsRepo.patch(id, cleaned, Date.now());
  }

  // ── Pin / Unpin ───────────────────────────────────────────────────────────

  pinSession(id: SessionId): void {
    this.sessionsRepo.pin(id, Date.now());
  }

  unpinSession(id: SessionId): void {
    this.sessionsRepo.unpin(id);
  }

  // ── Group ──────────────────────────────────────────────────────────────────

  setSessionGroup(id: SessionId, label: string | null): void {
    // Normalise empty string → null (no group)
    const normalised = label?.trim() || null;
    this.sessionsRepo.setGroup(id, normalised);
  }

  // ── Archive / Unarchive ────────────────────────────────────────────────────

  archiveSession(id: SessionId): void {
    this.sessionsRepo.archive(id, Date.now());
  }

  unarchiveSession(id: SessionId): void {
    this.sessionsRepo.unarchive(id);
  }

  // ── Fork ───────────────────────────────────────────────────────────────────

  forkSession(
    srcId:       SessionId,
    untilTurnId?: TurnId,
  ): { sessionId: SessionId; messageCount: number } {
    const newId = asSessionId(crypto.randomUUID());
    const src   = this.requireSession(srcId);
    const title = `${src.title} (fork)`;
    const now   = this.nextTs();
    const count = this.sessionsRepo.forkInto(srcId, newId, title, now, untilTurnId);
    return { sessionId: newId, messageCount: count };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  deleteSession(id: SessionId): void {
    this.registry.clear(id);
    this.sessionsRepo.delete(id);  // cascades to turns + messages via FK
  }

  // ── Turn ────────────────────────────────────────────────────────────────────

  /**
   * Create and immediately start a new turn for the session.
   *
   * Returns the Turn record AND an AbortSignal — pass the signal to
   * llm.stream() so Stop propagates without extra wiring.
   *
   * Throws 'session_busy' if a turn is already running for this session.
   */
  startTurn(input: StartTurnInput): { turn: Turn; signal: AbortSignal } {
    if (this.registry.isRunning(input.sessionId)) {
      throw new Error('session_busy: a turn is already running for this session');
    }

    const now = Date.now();

    // Heal stale 'running' rows left by a previous process crash.
    // better-sqlite3 is sync, so this + insert below are effectively atomic.
    this.turnsRepo.abortStale(input.sessionId, now);

    const session = this.requireSession(input.sessionId);
    const turnId  = asTurnId(crypto.randomUUID());
    this.turnsRepo.insert({
      id:           turnId,
      sessionId:    input.sessionId,
      mode:         input.mode,
      agentSubMode: input.agentSubMode,
      branchId:     session.activeBranchId ?? undefined,
      userInput:    input.userInput,
      startedAt:    now,
    });
    this.turnsRepo.setRunning(turnId);
    this.sessionsRepo.touchActivity(input.sessionId, now);

    const signal = this.registry.register(input.sessionId, turnId);
    return { turn: this.requireTurn(turnId), signal };
  }

  completeTurn(turnId: TurnId, usage: CompleteTurnInput = {}): void {
    const turn = this.requireTurn(turnId);
    this.turnsRepo.complete(turnId, {
      status:             'completed',
      completedAt:        Date.now(),
      usageInputTokens:   usage.usageInputTokens,
      usageOutputTokens:  usage.usageOutputTokens,
      costUsd:            usage.costUsd,
      iterations:         usage.iterations,
    });
    this.registry.clear(turn.sessionId);
  }

  failTurn(turnId: TurnId, errorCode: string, errorMessage?: string): void {
    const turn = this.requireTurn(turnId);
    this.turnsRepo.complete(turnId, {
      status:       'failed',
      completedAt:  Date.now(),
      errorCode,
      errorMessage,
    });
    this.registry.clear(turn.sessionId);
  }

  /**
   * Abort a running turn — fires the AbortSignal so the LLM stream stops,
   * then marks the turn as aborted in the DB.
   */
  abortTurn(sessionId: SessionId, turnId: TurnId): void {
    this.registry.abort(sessionId);   // signals AbortController → stream stops
    this.turnsRepo.complete(turnId, {
      status:      'aborted',
      completedAt: Date.now(),
    });
    this.registry.clear(sessionId);
  }

  /**
   * Process-crash startup recovery: any turn still in 'running'/'pending' state
   * across ALL sessions was orphaned by a crash — mark it aborted so future
   * startTurn() calls aren't blocked. Called once at process start.
   */
  recoverStuckTurns(): { healed: number } {
    const healed = this.turnsRepo.abortAllStale(Date.now());
    return { healed };
  }

  getTurn(id: TurnId): Turn | undefined {
    const row = this.turnsRepo.findById(id);
    return row ? toTurn(row) : undefined;
  }

  getActiveTurn(sessionId: SessionId): Turn | undefined {
    const turnId = this.registry.getActiveTurnId(sessionId);
    if (!turnId) return undefined;
    return this.getTurn(turnId);
  }

  listTurns(sessionId: SessionId, limit = 50): Turn[] {
    return this.turnsRepo.listForSession(sessionId, limit).map(toTurn);
  }

  // ── Message ─────────────────────────────────────────────────────────────────

  appendMessage(input: AppendMessageInput): Message {
    const id  = asMessageId(crypto.randomUUID());
    const now = this.nextTs();
    const blocksJson = JSON.stringify(input.blocks);
    this.messagesRepo.insert({
      id,
      sessionId:   input.sessionId,
      turnId:      input.turnId,
      role:        input.role,
      kind:        input.kind ?? 'normal',
      blocksJson,
      interrupted: input.interrupted ?? false,
      createdAt:   now,
    });
    return this.requireMessage(id);
  }

  markMessageInterrupted(id: MessageId): void {
    this.messagesRepo.markInterrupted(id);
  }

  /**
   * Load message history for LLM context — chronological order, last N messages.
   *
   * Summary-aware: when a kind='summary' message exists, the list begins at
   * that summary (inclusive). Branch-aware: if the session has an active branch,
   * reconstructs the full linear history across the ancestor chain first, then
   * applies the summary boundary in-memory.
   *
   * For UI rendering, use listMessages() instead — it ignores summary slicing.
   */
  loadHistory(sessionId: SessionId, limit = 500): Message[] {
    const session = this.requireSession(sessionId);

    if (!session.activeBranchId) {
      return this.messagesRepo.listForSessionFromSummary(sessionId, limit).map(toMessage);
    }

    const all = this.loadBranchMessages(sessionId, session.activeBranchId);

    // Find last summary boundary and slice from there.
    let startIdx = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]!.kind === 'summary') { startIdx = i; break; }
    }
    return all.slice(startIdx, startIdx + limit);
  }

  /** All messages belonging to one turn — used by post-turn extraction. */
  loadMessagesForTurn(turnId: TurnId): Message[] {
    return this.messagesRepo.listForTurn(turnId).map(toMessage);
  }

  /**
   * Cursor-based list for the frontend chat UI.
   * Both first page and older pages return messages **newest-first**.
   * Pass the last returned message's `createdAt` as `before` to load
   * the next (older) page (scroll-up pagination).
   *
   * Branch-aware: when the session has an active branch, reconstructs the
   * full linear message history across the ancestor chain, then applies
   * cursor slicing in-memory. Branch depth is shallow enough that loading
   * the full chain is cheaper than multi-pass SQL pagination.
   */
  listMessages(sessionId: SessionId, input: ListMessagesInput = {}): Message[] {
    const limit   = input.limit ?? 50;
    const session = this.requireSession(sessionId);

    if (!session.activeBranchId) {
      if (input.before === undefined) {
        return this.messagesRepo.listForSession(sessionId, limit).map(toMessage);
      }
      return this.messagesRepo.listBefore(sessionId, input.before, limit).map(toMessage);
    }

    // Branch-aware path: reconstruct full linear history (oldest → newest).
    const all = this.loadBranchMessages(sessionId, session.activeBranchId);

    if (input.before === undefined) {
      // First page: last `limit` messages, newest-first.
      return all.slice(-limit).reverse();
    }

    // Cursor page: messages older than `before`, newest-first.
    const cutoff = all.findIndex(m => m.createdAt >= input.before!);
    const older  = cutoff <= 0 ? [] : all.slice(0, cutoff);
    return older.slice(-limit).reverse();
  }

  // ── Branch ──────────────────────────────────────────────────────────────────

  /**
   * Fork the conversation at `fromTurnId`, creating a new empty branch that
   * starts after that turn. Sets `session.activeBranchId` to the new branch so
   * subsequent turns are appended there.
   *
   * On the very first fork of a session:
   *   • Creates a root branch record to own the pre-fork history.
   *   • Backfills all existing `branch_id = NULL` turns to the root branch.
   *
   * Returns the new branch's id.
   */
  forkMessage(input: ForkMessageInput): { branchId: BranchId } {
    const { sessionId, fromTurnId } = input;
    const now = this.nextTs();

    // Snapshot current branch_id BEFORE any backfill.
    const forkTurnRow = this.turnsRepo.findById(fromTurnId);
    if (!forkTurnRow) throw new Error(`turn_not_found: ${fromTurnId}`);
    const preForkBranchId = forkTurnRow.branch_id as BranchId | null;

    // Ensure a root branch exists; backfill pre-fork turns on first call.
    let rootBranchId: BranchId;
    const existingRoot = this.branchesRepo.findRoot(sessionId);
    if (!existingRoot) {
      rootBranchId = asBranchId(crypto.randomUUID());
      this.branchesRepo.insert({
        id:        rootBranchId,
        sessionId,
        createdAt: now,
      });
      this.turnsRepo.assignBranch(sessionId, rootBranchId);
    } else {
      rootBranchId = existingRoot.id as BranchId;
    }

    const parentBranchId = preForkBranchId ?? rootBranchId;

    const newBranchId = asBranchId(crypto.randomUUID());
    this.branchesRepo.insert({
      id:              newBranchId,
      sessionId,
      parentBranchId,
      forkFromTurnId:  fromTurnId,
      createdAt:       now + 1,
    });

    this.sessionsRepo.setActiveBranch(sessionId, newBranchId);
    return { branchId: newBranchId };
  }

  /**
   * Switch the session's active branch. Pass a branchId to view that branch's
   * history, or null to return to the un-branched root view (only valid before
   * any fork has occurred).
   */
  switchBranch(input: SwitchBranchInput): void {
    const { sessionId, branchId } = input;
    if (branchId !== null) {
      const branch = this.branchesRepo.findById(branchId);
      if (!branch || branch.session_id !== sessionId) {
        throw new Error(`branch_not_found: ${branchId}`);
      }
    }
    this.sessionsRepo.setActiveBranch(sessionId, branchId);
  }

  /**
   * Siblings at a fork point — the parent branch plus all child branches that
   * forked from the same turn. Used to render the `< N/M >` navigator.
   */
  listBranchSiblings(sessionId: SessionId, forkFromTurnId: TurnId): BranchSibling[] {
    const forkTurn = this.turnsRepo.findById(forkFromTurnId);
    if (!forkTurn) return [];

    const parentBranchId = (forkTurn.branch_id ?? null) as BranchId | null;
    const children       = this.branchesRepo.listSiblingsAt(forkFromTurnId);
    const session        = this.requireSession(sessionId);

    // Sibling order: parent branch first, then children in creation order.
    type Entry = { branchId: BranchId; createdAt: number };
    const entries: Entry[] = [];

    if (parentBranchId !== null) {
      const parentRow = this.branchesRepo.findById(parentBranchId);
      if (parentRow) entries.push({ branchId: parentBranchId, createdAt: parentRow.created_at });
    }
    for (const c of children) {
      entries.push({ branchId: c.id as BranchId, createdAt: c.created_at });
    }

    const total = entries.length;
    return entries.map((e, i) => ({
      branchId:  e.branchId,
      position:  i + 1,
      total,
      isActive:  e.branchId === session.activeBranchId,
      createdAt: e.createdAt,
    }));
  }

  /** All branches for a session — useful for rendering the branch tree UI. */
  listBranches(sessionId: SessionId): Branch[] {
    return this.branchesRepo.listForSession(sessionId).map(b => ({
      id:             b.id             as BranchId,
      sessionId:      b.session_id     as SessionId,
      parentBranchId: (b.parent_branch_id ?? null) as BranchId | null,
      forkFromTurnId: (b.fork_from_turn_id ?? null) as TurnId   | null,
      createdAt:      b.created_at,
    }));
  }

  /**
   * Reconstruct the full linear message history for `branchId` by walking up
   * the ancestor chain and concatenating branch segments.
   *
   * For each branch in the chain [root → … → branchId]:
   *   - Root segment: all messages in the session on the root branch, up to
   *     the fork point (plus turnless system messages).
   *   - Child segments: only messages whose turns have branch_id = that branch,
   *     up to the next fork point.
   *
   * Result is chronological (oldest first).
   */
  private loadBranchMessages(sessionId: SessionId, branchId: BranchId): Message[] {
    const rows    = this.branchesRepo.listForSession(sessionId);
    const branchMap = new Map(rows.map(b => [b.id, b]));
    const table   = new BranchAncestorTable(
      rows.map(b => ({
        id:             b.id as BranchId,
        parentBranchId: (b.parent_branch_id ?? null) as BranchId | null,
      })),
    );

    const chain    = table.getAncestorChain(branchId);
    const segments: MessageRow[][] = [];

    for (let i = 0; i < chain.length; i++) {
      const curId   = chain[i]!;
      const childId = chain[i + 1];

      let cutoffAt: number | undefined;
      if (childId) {
        const child    = branchMap.get(childId);
        const forkTurn = child?.fork_from_turn_id
          ? this.turnsRepo.findById(child.fork_from_turn_id as TurnId)
          : undefined;
        cutoffAt = forkTurn?.started_at;
      }

      const msgs = i === 0
        ? this.messagesRepo.listForRootSegment(sessionId, curId, cutoffAt)
        : this.messagesRepo.listForChildSegment(curId, cutoffAt);
      segments.push(msgs);
    }

    return segments.flat().map(toMessage);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private requireSession(id: SessionId): Session {
    const row = this.sessionsRepo.findById(id);
    if (!row) throw new Error(`session_not_found: ${id}`);
    return toSession(row);
  }

  private requireTurn(id: TurnId): Turn {
    const row = this.turnsRepo.findById(id);
    if (!row) throw new Error(`turn_not_found: ${id}`);
    return toTurn(row);
  }

  private requireMessage(id: MessageId): Message {
    const row = this.messagesRepo.findById(id);
    if (!row) throw new Error(`message_not_found: ${id}`);
    return toMessage(row);
  }
}
