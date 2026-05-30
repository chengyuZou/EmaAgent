import crypto from 'node:crypto';
import {
  SessionsRepo,
  TurnsRepo,
  MessagesRepo,
  nextCursorFor,
  type SessionRow,
  type TurnRow,
  type MessageRow,
} from '@ema-agent/storage';
import {
  type SessionId,
  type TurnId,
  type MessageId,
  type CharacterCardId,
  type TurnMode,
  type AgentSubMode,
  type MessageBlocks,
  asSessionId,
  asTurnId,
  asMessageId,
} from '@ema-agent/contracts';
import type { Database } from '@ema-agent/storage';
import { RunRegistry } from './run-registry.js';
import type {
  Session,
  Turn,
  Message,
  CreateSessionInput,
  StartTurnInput,
  CompleteTurnInput,
  AppendMessageInput,
  ListSessionsInput,
  ListSessionsOutput,
  ListMessagesInput,
} from './types.js';

// ── Row → domain object converters (module-private) ──────────────────────────

function toSession(row: SessionRow): Session {
  return {
    id: row.id as SessionId,
    title: row.title,
    characterCardId: row.character_card_id as CharacterCardId,
    workspaceRoots: JSON.parse(row.workspace_roots_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    pinned:        row.pinned === 1,
    pinnedAt:      row.pinned_at,
    groupLabel:    row.group_label,
    parentSessionId: row.parent_session_id as SessionId | null,
    runningTurnCount: 0,    // populated by caller
    meta: JSON.parse(row.meta_json) as Record<string, unknown>,
    lastMode:    (row.last_mode    ?? null) as TurnMode    | null,
    lastSubMode: (row.last_sub_mode ?? null) as AgentSubMode | null,
  };
}

function toTurn(row: TurnRow): Turn {
  return {
    id: row.id as TurnId,
    sessionId: row.session_id as SessionId,
    mode: row.mode,
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
    meta: JSON.parse(row.meta_json) as Record<string, unknown>,
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
    meta:        JSON.parse(row.meta_json) as Record<string, unknown>,
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
  private readonly turnsRepo: TurnsRepo;
  private readonly messagesRepo: MessagesRepo;
  private readonly registry: RunRegistry;
  /** Monotonically increasing clock — ensures created_at is unique even for sub-ms bursts. */
  private lastTs = 0;

  constructor({ db }: SessionStoreDeps) {
    this.sessionsRepo = new SessionsRepo(db.sqlite);
    this.turnsRepo    = new TurnsRepo(db.sqlite);
    this.messagesRepo = new MessagesRepo(db.sqlite);
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
    });
    return this.requireSession(id);
  }

  getSession(id: SessionId): Session {
    return this.requireSession(id);
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
    const map = (rows: SessionRow[]) => rows.map(r => {
      const s = toSession(r);
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

  forkSession(srcId: SessionId): { sessionId: SessionId; messageCount: number } {
    const newId = asSessionId(crypto.randomUUID());
    const src   = this.requireSession(srcId);
    const title = `${src.title} (fork)`;
    const now   = this.nextTs();
    const count = this.sessionsRepo.forkInto(srcId, newId, title, now);
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

    const turnId = asTurnId(crypto.randomUUID());
    this.turnsRepo.insert({
      id:           turnId,
      sessionId:    input.sessionId,
      mode:         input.mode,
      agentSubMode: input.agentSubMode,
      userInput:    input.userInput,
      startedAt:    now,
    });
    this.turnsRepo.setRunning(turnId);
    this.sessionsRepo.touch(input.sessionId, now);

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
    // blocks is always serialized to JSON for the TEXT column.
    // Simple string content is stored as a JSON string: "\"hello world\""
    const blocksJson = typeof input.blocks === 'string'
      ? JSON.stringify(input.blocks)
      : JSON.stringify(input.blocks);
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
   * Summary-aware: when a kind='summary' message exists in this session, the
   * returned list begins at that summary (inclusive). Older messages are
   * implicitly omitted — they were compacted by MemoryPlanner.
   *
   * For UI rendering, use listMessages() instead — it ignores summary slicing.
   */
  loadHistory(sessionId: SessionId, limit = 500): Message[] {
    return this.messagesRepo.listForSessionFromSummary(sessionId, limit).map(toMessage);
  }

  /** All messages belonging to one turn — used by post-turn extraction. */
  loadMessagesForTurn(turnId: TurnId): Message[] {
    return this.messagesRepo.listForTurn(turnId).map(toMessage);
  }

  /**
   * Cursor-based list for the frontend chat UI.
   * Returns messages newest-first; pass the last item's createdAt as `before`
   * to load older messages (scroll-up pagination).
   */
  listMessages(sessionId: SessionId, input: ListMessagesInput = {}): Message[] {
    const limit = input.limit ?? 50;

    if (input.before === undefined) {
      // First page: most recent N messages, reversed to newest-first
      return this.messagesRepo.listForSession(sessionId, limit).reverse().map(toMessage);
    }

    return this.messagesRepo.listBefore(sessionId, input.before, limit).map(toMessage);
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