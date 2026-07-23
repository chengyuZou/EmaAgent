// 作为 Session 模块唯一 Facade，管理会话、Turn、消息和独立 Session Fork。
import crypto from 'node:crypto';
import { SessionsRepo, TurnsRepo, MessagesRepo, nextCursorFor, type SessionRow, type SessionRowEnriched, type SessionSearchRow, type TurnRow, type TurnIdPage, type TurnIdPageCursor, type MessageRow, } from '@ema-agent/storage';
import { type SessionId, type TurnId, type MessageId, asSessionId, asTurnId, asMessageId } from '@ema-agent/ids';
import { SessionOwnershipError } from './errors.js';
import type { SessionOwnershipFacade } from './types.js';
import { parseMessageBlocksJson } from './message.js';
import type { MessageBlocks } from './message.js';
import type { Database } from '@ema-agent/storage';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/turn';
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
  SearchSessionsInput,
  SearchSessionsOutput,
} from './types.js';

// ── Row → domain object converters (module-private) ──────────────────────────

function toSession(row: SessionRow): Session {
  return {
    id: row.id as SessionId,
    title: row.title,
    workspaceRoot:  row.workspace_root ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at,
    pinned:        row.pinned === 1,
    pinnedAt:      row.pinned_at,
    groupLabel:    row.group_label,
    parentSessionId:  row.parent_session_id  as SessionId  | null,
    runningTurnCount: 0,    // populated by caller
    executionProfile: row.execution_profile,
    narrativePolicy: row.narrative_policy,
    preferredProviderConfigId: row.preferred_provider_config_id ?? null,
    preferredModelId: row.preferred_model_id ?? null,
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
  return {
    ...s,
    runningTurnCount: row.running_turn_count,
    lastTurnStatus,
    hasUnread,
  };
}

function toTurn(row: TurnRow): Turn {
  return {
    id:           row.id        as TurnId,
    sessionId:    row.session_id as SessionId,
    triggerType: row.trigger_type,
    executionProfile: row.execution_profile,
    narrativePolicy: row.narrative_policy,
    status: row.status,
    userInput: row.user_input,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    iterations: row.iterations,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
  };
}

function toMessage(row: MessageRow): Message {
  const blocks = parseMessageBlocksJson(row.blocks_json, row.role, row.kind);
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

const DEFAULT_HISTORY_LIMIT = 500;

// ── SessionStore ──────────────────────────────────────────────────────────────

export interface SessionStoreDeps {
  db: Database;
  /**
   * Called after a session is deleted from the DB. The wiring layer injects
   * `removeSessionDir(dataDir, sessionId)` so the session's audio/artifact/
   * scratchpad files are cleaned alongside the DB rows.
   */
  onSessionRemoved?: (sessionId: string) => void;
  /** 最后一轮重发成功回滚后，清理该 Turn 派生的音频和临时文件。 */
  onTurnRemoved?: (sessionId: string, turnId: string) => void;
}

/**
 * SessionStore — single Facade for all session/turn/message state.
 *
 * Concurrency contract:
 *   One session allows at most ONE running turn at a time.
 *   startTurn() enforces this via RunRegistry (in-memory) + DB heal on startup.
 *   Multiple sessions can have concurrent running turns independently.
 */
export class SessionStore implements SessionOwnershipFacade {
  private readonly sessionsRepo: SessionsRepo;
  private readonly turnsRepo:    TurnsRepo;
  private readonly messagesRepo: MessagesRepo;
  private readonly registry:     RunRegistry;
  private readonly db:           Database;
  private readonly onSessionRemoved?: (sessionId: string) => void;
  private readonly onTurnRemoved?: (sessionId: string, turnId: string) => void;
  /** Monotonically increasing clock — ensures created_at is unique even for sub-ms bursts. */
  private lastTs = 0;

  constructor({ db, onSessionRemoved, onTurnRemoved }: SessionStoreDeps) {
    this.sessionsRepo = new SessionsRepo(db.sqlite);
    this.turnsRepo    = new TurnsRepo(db.sqlite);
    this.messagesRepo = new MessagesRepo(db.sqlite);
    this.registry     = new RunRegistry();
    this.db           = db;
    this.onSessionRemoved = onSessionRemoved;
    this.onTurnRemoved = onTurnRemoved;
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
      workspaceRoot:    input.workspaceRoot,
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
    const sessions = visible.map(toSessionEnriched);
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
    const map = (rows: SessionRowEnriched[]) => rows.map(toSessionEnriched);
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
      workspaceRoot?:  string | null;
      executionProfile?: ExecutionProfile;
      narrativePolicy?: NarrativePolicy;
      preferredModel?: {
        providerConfigId: string;
        modelId: string;
      } | null;
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
    if (patch.workspaceRoot !== undefined) {
      cleaned.workspaceRoot = patch.workspaceRoot;
    }
    if (patch.executionProfile !== undefined) cleaned.executionProfile = patch.executionProfile;
    if (patch.narrativePolicy !== undefined) cleaned.narrativePolicy = patch.narrativePolicy;
    if (patch.preferredModel !== undefined) {
      cleaned.preferredModel = patch.preferredModel;
    }

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

  /**
   * Fork a session into a new independent session.
   *
   * `untilTurnId` 为空时完整复制；提供时只复制到该 Turn（含）为止。
   * 新 Session 重新生成 Turn、Message 与 Attachment ID，不继承 Task、
   * AgentRun 或正在运行的外部副作用。
   */
  forkSession(
    srcId:        SessionId,
    untilTurnId?: TurnId,
  ): { sessionId: SessionId; messageCount: number } {
    const src   = this.requireSession(srcId);
    const newId = asSessionId(crypto.randomUUID());
    const title = `${src.title} (fork)`;
    const now   = this.nextTs();
    const messageCount = this.sessionsRepo.forkInto(srcId, newId, title, now, untilTurnId);
    return { sessionId: newId, messageCount };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  deleteSession(id: SessionId): void {
    this.registry.clear(id);
    this.sessionsRepo.delete(id);  // cascades to turns + messages via FK
    // Clean the per-session directory tree (audio/artifacts/scratchpad).
    // DB rows cascade-cleaned; this catches the file side that has no FK.
    this.onSessionRemoved?.(id as string);
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

    // 与消息/分支同一单调时钟: turn 的 started_at 在进程内严格递增,
    // 同毫秒 tie 不再发生, 排序/游标/删除级联的"之后"语义才有唯一解。
    const now = this.nextTs();

    // Heal stale 'running' rows left by a previous process crash.
    // better-sqlite3 is sync, so this + insert below are effectively atomic.
    this.turnsRepo.abortStale(input.sessionId, now);

    this.requireSession(input.sessionId);
    const turnId  = asTurnId(crypto.randomUUID());
    this.turnsRepo.insert({
      id:           turnId,
      sessionId:    input.sessionId,
      triggerType: input.triggerType,
      executionProfile: input.executionProfile,
      narrativePolicy: input.narrativePolicy,
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
   * 只请求正在运行的执行流停止，不提前写数据库终态。执行流会先收拢工具和
   * Subagent，再由对应生命周期 Facade 提交 aborted/cancelled。
   */
  requestAbort(sessionId: SessionId): void {
    this.registry.abort(sessionId);
  }

  /**
   * Idempotent: release the in-memory running-turn lock for a session.
   *
   * Safe to call regardless of whether completeTurn/failTurn/abortTurn already
   * cleared it. Covers the leak where a terminal method throws before reaching
   * its own `registry.clear()` (e.g. `requireTurn` on a missing row, or a DB
   * write error): without this, the orchestrator's end-of-turn finally has no
   * way to release the lock, and the session stays `session_busy` until the
   * process restarts. Intended to be called unconditionally from the
   * orchestrator's turn finally/catch blocks.
   */
  clearRunning(sessionId: SessionId): void {
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

  /**
   * 仅回滚一个 Session 的最后一轮，供最后一条用户消息重新编辑并发送。
   *
   * 这不是任意历史删除：运行中的 Turn、非最新 Turn，以及已被持久 Task
   * 引用的 Turn 都会拒绝。文件、网络请求等外部副作用不会被伪装成已撤销。
   */
  rewindLastTurn(sessionId: SessionId, turnId: TurnId): { turnId: TurnId } {
    this.assertTurnOwnership(sessionId, turnId);
    if (this.registry.isRunning(sessionId)) {
      throw new Error(`turn_running: ${turnId}`);
    }

    const latest = this.turnsRepo.listForSession(sessionId, 1)[0];
    if (!latest || latest.id !== (turnId as string)) {
      throw new Error(`turn_not_latest: ${turnId}`);
    }
    if (latest.status === 'pending' || latest.status === 'running') {
      throw new Error(`turn_running: ${turnId}`);
    }

    // Task.created_by_turn_id 使用 RESTRICT；若该轮已创建持久 Task，
    // 整个事务会回滚，避免 UI 看似撤销但 Task 仍悬挂。
    this.db.sqlite.transaction(() => {
      this.messagesRepo.deleteForTurn(turnId);
      this.turnsRepo.delete(turnId);
      this.sessionsRepo.touchActivity(sessionId, this.nextTs());
    })();

    this.onTurnRemoved?.(sessionId as string, turnId as string);
    return { turnId };
  }

  /** 启动恢复等内部任务使用的轻量 Turn ID 游标页，不加载正文和其他领域对象。 */
  listTurnIdsPage(
    sessionId: SessionId,
    cursor?: TurnIdPageCursor,
    limit = 1_000,
  ): TurnIdPage {
    return this.turnsRepo.listIdsForSessionPage(sessionId, cursor, limit);
  }

  /** 校验 turn 属于指定 session；供跨模块写入前通过 Facade 调用。 */
  assertTurnOwnership(sessionId: SessionId, turnId: TurnId): void {
    const turn = this.requireTurn(turnId);
    if (turn.sessionId !== sessionId) {
      throw new SessionOwnershipError('turn', turnId, sessionId, turn.sessionId);
    }
  }

  /** 校验 message 属于指定 session；不向调用方暴露仓储。 */
  assertMessageOwnership(sessionId: SessionId, messageId: MessageId): void {
    const message = this.requireMessage(messageId);
    if (message.sessionId !== sessionId) {
      throw new SessionOwnershipError('message', messageId, sessionId, message.sessionId);
    }
  }

  // ── Message ─────────────────────────────────────────────────────────────────

  appendMessage(input: AppendMessageInput): Message {
    if (input.turnId) {
      this.assertTurnOwnership(input.sessionId, input.turnId);
    }
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
   * that summary (inclusive).
   *
   * For UI rendering, use listMessages() instead — it ignores summary slicing.
   */
  loadHistory(sessionId: SessionId, limit = DEFAULT_HISTORY_LIMIT): Message[] {
    this.requireSession(sessionId);
    return this.messagesRepo.listForSessionFromSummary(sessionId, limit).map(toMessage);
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
   */
  listMessages(sessionId: SessionId, input: ListMessagesInput = {}): Message[] {
    const limit   = input.limit ?? 50;
    this.requireSession(sessionId);
    if (input.before === undefined) {
      return this.messagesRepo.listForSession(sessionId, limit).map(toMessage);
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
