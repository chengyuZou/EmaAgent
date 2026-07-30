// 集中管理 Session、Turn、消息与独立 Session Fork 的领域读写。
import crypto from 'node:crypto';
import { SessionsRepo, TurnsRepo, MessagesRepo, nextCursorFor, type SessionRow, type SessionRowEnriched, type SessionSearchRow, type TurnRow, type TurnIdPage, type TurnIdPageCursor, type MessageRow, } from '@ema-agent/storage';
import { type SessionId, type TurnId, type MessageId, asSessionId, asTurnId, asMessageId } from '@ema-agent/ids';
import { SessionOwnershipError } from './errors.js';
import type { SessionOwnershipFacade } from './types.js';
import { parseMessageBlocksJson } from './message.js';
import type { MessageBlocks } from './message.js';
import type { Database } from '@ema-agent/storage';
import { RunRegistry } from './run-registry.js';
import type {
  Session,
  Turn,
  Message,
  CreateSessionInput,
  PatchSessionInput,
  StartTurnInput,
  CompleteTurnInput,
  AppendMessageInput,
  ListSessionsInput,
  ListSessionsOutput,
  ListMessagesInput,
  ListTurnIndexInput,
  TurnIndexPage,
  ListMessageWindowInput,
  MessageWindow,
  SearchSessionsInput,
  SearchSessionsOutput,
} from './types.js';

// ── 数据库行转换 ─────────────────────────────────────────────────────────────

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
    runningTurnCount: 0,
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
const TURN_INDEX_DEFAULT_LIMIT = 200;
const TURN_INDEX_MAX_LIMIT = 500;
const TURN_INDEX_PREVIEW_LENGTH = 180;
const MESSAGE_WINDOW_DEFAULT_BEFORE = 8;
const MESSAGE_WINDOW_DEFAULT_AFTER = 12;
const MESSAGE_WINDOW_MAX_SIDE = 25;
const MESSAGE_WINDOW_MAX_TOTAL = 40;

// ── Session 聚合 ─────────────────────────────────────────────────────────────

export interface SessionStoreDeps {
  db: Database;
  /** Session 删除后清理数据库外的音频、附件和工具结果文件。 */
  onSessionRemoved?: (sessionId: string) => void;
  /** 最后一轮重发成功回滚后，清理该 Turn 派生的音频和临时文件。 */
  onTurnRemoved?: (sessionId: string, turnId: string) => void;
}

/** 管理 Session 聚合；当前同一 Session 只允许一个根 Turn 运行。 */
export class SessionStore implements SessionOwnershipFacade {
  private readonly sessionsRepo: SessionsRepo;
  private readonly turnsRepo:    TurnsRepo;
  private readonly messagesRepo: MessagesRepo;
  private readonly registry:     RunRegistry;
  private readonly db:           Database;
  private readonly onSessionRemoved?: (sessionId: string) => void;
  private readonly onTurnRemoved?: (sessionId: string, turnId: string) => void;
  /** 单调时间戳避免同毫秒写入破坏游标边界。 */
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

  // ── 内部时间 ────────────────────────────────────────────────────────────────

  /** 返回严格递增的进程内时间戳。 */
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

  /** 无异常检查，供调用方识别删库后残留的客户端 Session ID。 */
  sessionExists(id: SessionId): boolean {
    return this.sessionsRepo.findById(id) !== undefined;
  }

  listSessions(input: ListSessionsInput = {}): ListSessionsOutput {
    const limit = input.limit ?? 50;
    // 多取一行判断是否仍有下一页。
    const rows = this.sessionsRepo.listActive(limit + 1, input.cursor);
    const hasMore = rows.length > limit;
    const visible = hasMore ? rows.slice(0, limit) : rows;
    const sessions = visible.map(toSessionEnriched);
    const nextCursor = hasMore
      ? nextCursorFor(visible[visible.length - 1]!)
      : undefined;
    return { sessions, nextCursor };
  }

  /** 返回左侧 Session 栏需要的分组投影。 */
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
    if (!trimmed) return;
    this.sessionsRepo.updateTitle(id, trimmed, Date.now());
  }

  /**
   * 在一个事务内更新 Session 偏好。
   * `groupLabel` 的 null 表示移出分组，undefined 表示保持不变。
   */
  patchSession(
    id: SessionId,
    patch: PatchSessionInput,
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

  // ── 置顶 ───────────────────────────────────────────────────────────────────

  pinSession(id: SessionId): void {
    this.sessionsRepo.pin(id, Date.now());
  }

  unpinSession(id: SessionId): void {
    this.sessionsRepo.unpin(id);
  }

  // ── 分组 ───────────────────────────────────────────────────────────────────

  setSessionGroup(id: SessionId, label: string | null): void {
    const normalised = label?.trim() || null;
    this.sessionsRepo.setGroup(id, normalised);
  }

  // ── 归档 ───────────────────────────────────────────────────────────────────

  archiveSession(id: SessionId): void {
    this.sessionsRepo.archive(id, Date.now());
  }

  unarchiveSession(id: SessionId): void {
    this.sessionsRepo.unarchive(id);
  }

  // ── 独立 Session Fork ──────────────────────────────────────────────────────

  /**
   * 创建独立 Session 副本；`untilTurnId` 为空时完整复制，否则复制到该 Turn（含）。
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

  // ── 删除 ───────────────────────────────────────────────────────────────────

  deleteSession(id: SessionId): void {
    this.registry.clear(id);
    this.sessionsRepo.delete(id);
    // 数据库行由外键级联；文件目录需要显式清理。
    this.onSessionRemoved?.(id as string);
  }

  // ── Turn ────────────────────────────────────────────────────────────────────

  /** 创建根 Turn，并返回贯穿 LLM 与工具执行的取消信号。 */
  startTurn(input: StartTurnInput): { turn: Turn; signal: AbortSignal } {
    if (this.registry.isRunning(input.sessionId)) {
      throw new Error('session_busy: a turn is already running for this session');
    }

    // started_at 严格递增，保证分页和“之后”的语义唯一。
    const now = this.nextTs();

    // 新 Turn 开始前收口同 Session 的崩溃残留状态。
    this.turnsRepo.abortStale(input.sessionId, now);

    this.requireSession(input.sessionId);
    const turnId = input.turnId ?? asTurnId(crypto.randomUUID());
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

  /** 触发取消信号并提交 Turn 的 aborted 终态。 */
  abortTurn(sessionId: SessionId, turnId: TurnId): void {
    this.registry.abort(sessionId);
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

  /** 幂等释放内存运行锁，供 Turn 执行链的 finally 无条件调用。 */
  clearRunning(sessionId: SessionId): void {
    this.registry.clear(sessionId);
  }

  /** 启动时将崩溃遗留的 pending/running Turn 收口为 aborted。 */
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

  /** 后台派生缓存只在所有前台 Turn 都结束后执行维护。 */
  hasActiveTurns(): boolean {
    return this.registry.activeSessionCount() > 0;
  }

  /** LocalHost 通过活动数量变化及时抢占低优先级维护，不需要轮询 Session。 */
  subscribeActiveTurns(listener: (activeCount: number) => void): () => void {
    return this.registry.subscribe(listener);
  }

  listTurns(sessionId: SessionId, limit = 50): Turn[] {
    return this.turnsRepo.listForSession(sessionId, limit).map(toTurn);
  }

  /** 为长 Session 提供不含消息正文的轻量 Turn 导航索引。 */
  listTurnIndex(
    sessionId: SessionId,
    input: ListTurnIndexInput = {},
  ): TurnIndexPage {
    this.requireSession(sessionId);
    const limit = normaliseIntegerLimit(
      input.limit,
      TURN_INDEX_DEFAULT_LIMIT,
      TURN_INDEX_MAX_LIMIT,
      'turn_index_limit',
    );
    const cursor = input.cursor
      ? decodeTurnIndexCursor(input.cursor)
      : undefined;
    const page = this.turnsRepo.listForSessionPage(sessionId, cursor, limit);

    return {
      items: page.rows.map((row) => ({
        turnId: row.id as TurnId,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        status: row.status,
        triggerType: row.trigger_type,
        executionProfile: row.execution_profile,
        preview: formatTurnPreview(row.user_input_preview),
      })),
      nextCursor: page.nextCursor
        ? encodeTurnIndexCursor(page.nextCursor)
        : undefined,
    };
  }

  /** 按 Turn 边界读取旧消息窗口，避免把整个 Session 的正文一次载入内存。 */
  listMessageWindow(
    sessionId: SessionId,
    input: ListMessageWindowInput,
  ): MessageWindow {
    this.requireSession(sessionId);
    this.assertTurnOwnership(sessionId, input.anchorTurnId);

    const beforeTurns = normaliseIntegerLimit(
      input.beforeTurns,
      MESSAGE_WINDOW_DEFAULT_BEFORE,
      MESSAGE_WINDOW_MAX_SIDE,
      'message_window_before',
      true,
    );
    const afterTurns = normaliseIntegerLimit(
      input.afterTurns,
      MESSAGE_WINDOW_DEFAULT_AFTER,
      MESSAGE_WINDOW_MAX_SIDE,
      'message_window_after',
      true,
    );
    if (beforeTurns + afterTurns > MESSAGE_WINDOW_MAX_TOTAL) {
      throw new Error('message_window_too_large');
    }

    const window = this.turnsRepo.listWindowAround(
      sessionId,
      input.anchorTurnId,
      beforeTurns,
      afterTurns,
    );
    if (!window) throw new Error(`turn_not_found: ${input.anchorTurnId}`);

    const turnIds = window.rows.map((row) => row.id as TurnId);
    return {
      anchorTurnId: input.anchorTurnId,
      turns: window.rows.map(toTurn),
      messages: this.messagesRepo.listForTurns(sessionId, turnIds).map(toMessage),
      hasOlder: window.hasOlder,
      hasNewer: window.hasNewer,
    };
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

  /** 加载 LLM 可见历史；从最近 Summary 开始并保持时间正序。 */
  loadHistory(sessionId: SessionId, limit = DEFAULT_HISTORY_LIMIT): Message[] {
    this.requireSession(sessionId);
    return this.messagesRepo.listForSessionFromSummary(sessionId, limit).map(toMessage);
  }

  /** 加载一个 Turn 的全部消息，供 Turn 后处理使用。 */
  loadMessagesForTurn(turnId: TurnId): Message[] {
    return this.messagesRepo.listForTurn(turnId).map(toMessage);
  }

  /** 兼容现有聊天页的时间游标读取，结果保持最新优先。 */
  listMessages(sessionId: SessionId, input: ListMessagesInput = {}): Message[] {
    const limit   = input.limit ?? 50;
    this.requireSession(sessionId);
    if (input.before === undefined) {
      return this.messagesRepo.listForSession(sessionId, limit).map(toMessage);
    }
    return this.messagesRepo.listBefore(sessionId, input.before, limit).map(toMessage);
  }

  // ── 归属读取 ────────────────────────────────────────────────────────────────

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

function normaliseIntegerLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  errorCode: string,
  allowZero = false,
): number {
  const resolved = value ?? fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(errorCode);
  }
  return resolved;
}

function formatTurnPreview(userInput: string): string {
  const preview = userInput.replace(/\s+/g, ' ').trim();
  if (preview.length <= TURN_INDEX_PREVIEW_LENGTH) return preview;
  return `${preview.slice(0, TURN_INDEX_PREVIEW_LENGTH - 1)}…`;
}

function encodeTurnIndexCursor(cursor: TurnIdPageCursor): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    startedAt: cursor.startedAt,
    id: cursor.id,
  }), 'utf8').toString('base64url');
}

function decodeTurnIndexCursor(value: string): TurnIdPageCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as { version?: unknown; startedAt?: unknown; id?: unknown };
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.startedAt)
      || typeof parsed.id !== 'string'
      || parsed.id.length === 0
    ) {
      throw new Error('invalid');
    }
    return {
      startedAt: parsed.startedAt as number,
      id: parsed.id,
    };
  } catch {
    throw new Error('Invalid turn index cursor');
  }
}
