// 集中管理 Session、Turn、消息与独立 Session Fork 的领域读写。
import crypto from 'node:crypto';
import {
  MessagesRepo,
  SessionsRepo,
  TurnsRepo,
  nextCursorFor,
  type SessionRowEnriched,
  type TurnIdPage,
  type TurnIdPageCursor,
} from '@ema-agent/storage';
import { type SessionId, type TurnId, type MessageId, asSessionId, asTurnId, asMessageId } from '@ema-agent/ids';
import type { CompleteTurnInput, StartTurnInput, Turn } from '@ema-agent/turn';
import { SessionOwnershipError } from './errors.js';
import type { Database } from '@ema-agent/storage';
import { ActiveTurnRegistry } from './activeTurnRegistry.js';
import { SessionHistory } from './history/sessionHistory.js';
import {
  toMessage,
  toSearchHit,
  toSession,
  toSessionListItem,
  toTurn,
} from './persistence/rowMapping.js';
import type {
  Session,
  SessionListItem,
  Message,
  CreateSessionInput,
  PatchSessionInput,
  AppendMessageInput,
  ListSessionsInput,
  ListSessionsOutput,
  ListMessagesInput,
  ListTurnIndexInput,
  TurnIndexPage,
  ListMessageWindowInput,
  MessageWindow,
  PersistedToolInteraction,
  SearchSessionsInput,
  SearchSessionsOutput,
} from './types.js';

// ── Session 聚合 ─────────────────────────────────────────────────────────────

export interface SessionStoreDeps {
  db: Database;
  /** Session 删除后清理数据库外的音频、附件和工具结果文件。 */
  onSessionRemoved?: (sessionId: string) => void;
  /** 最后一轮重发成功回滚后，清理该 Turn 派生的音频和临时文件。 */
  onTurnRemoved?: (sessionId: string, turnId: string) => void;
}

/** 管理 Session 聚合；当前同一 Session 只允许一个根 Turn 运行。 */
export class SessionStore {
  private readonly sessionsRepo: SessionsRepo;
  private readonly turnsRepo:    TurnsRepo;
  private readonly messagesRepo: MessagesRepo;
  private readonly registry:     ActiveTurnRegistry;
  private readonly history:      SessionHistory;
  private readonly db:           Database;
  private readonly onSessionRemoved?: (sessionId: string) => void;
  private readonly onTurnRemoved?: (sessionId: string, turnId: string) => void;
  private readonly deletingSessions = new Set<string>();
  /** 单调时间戳避免同毫秒写入破坏游标边界。 */
  private lastTs = 0;

  constructor({ db, onSessionRemoved, onTurnRemoved }: SessionStoreDeps) {
    this.sessionsRepo = new SessionsRepo(db.sqlite);
    this.turnsRepo    = new TurnsRepo(db.sqlite);
    this.messagesRepo = new MessagesRepo(db.sqlite);
    this.registry     = new ActiveTurnRegistry();
    this.history      = new SessionHistory({
      sessionsRepo: this.sessionsRepo,
      turnsRepo: this.turnsRepo,
      messagesRepo: this.messagesRepo,
    });
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
    const sessions = visible.map(toSessionListItem);
    const nextCursor = hasMore
      ? nextCursorFor(visible[visible.length - 1]!)
      : undefined;
    return { sessions, nextCursor };
  }

  /** 侧栏四区投影：Session 置顶 / 项目分组 / 最近 / 已归档。 */
  listProjects(): {
    pinned:   SessionListItem[];
    byProject: Array<{ workspaceRoot: string; sessions: SessionListItem[] }>;
    recent:   SessionListItem[];
    archived: SessionListItem[];
  } {
    const projected = this.sessionsRepo.listProjects();
    const map = (rows: SessionRowEnriched[]) => rows.map(toSessionListItem);
    return {
      pinned:   map(projected.pinned),
      byProject: projected.byProject.map(g => ({ workspaceRoot: g.workspaceRoot, sessions: map(g.sessions) })),
      recent:   map(projected.recent),
      archived: map(projected.archived),
    };
  }

  searchSessions(input: SearchSessionsInput): SearchSessionsOutput {
    const query = input.query.trim();
    if (!query) return { results: [] };
    const rows = this.sessionsRepo.search(query, input.limit ?? 20);
    const results = rows.map(toSearchHit);
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
   * `workspaceRoot` 的 null 表示移出工作区，undefined 表示保持不变。
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
    if (patch.workspaceRoot !== undefined) {
      cleaned.workspaceRoot = patch.workspaceRoot;
    }
    if (patch.executionProfile !== undefined) cleaned.executionProfile = patch.executionProfile;
    if (patch.narrativePolicy !== undefined) cleaned.narrativePolicy = patch.narrativePolicy;
    if (patch.model !== undefined) {
      cleaned.model = patch.model;
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

  /** 删除协调开始后立刻阻止新 Turn，并向当前根 Turn 发出取消信号。 */
  beginSessionDeletion(id: SessionId): void {
    this.requireSession(id);
    if (this.deletingSessions.has(id)) {
      throw new Error(`session_deleting: ${id}`);
    }
    this.deletingSessions.add(id);
    const activeTurnId = this.registry.getActiveTurnId(id);
    if (activeTurnId) this.registry.abort(id, activeTurnId);
  }

  /** 跨模块准备失败时恢复 Session 的可运行状态。 */
  cancelSessionDeletion(id: SessionId): void {
    this.deletingSessions.delete(id);
  }

  deleteSession(id: SessionId): void {
    try {
      this.registry.discardSession(id);
      this.sessionsRepo.delete(id);
      // 数据库行由外键级联；文件目录需要显式清理。
      this.onSessionRemoved?.(id as string);
    } finally {
      this.deletingSessions.delete(id);
    }
  }

  // ── Turn ────────────────────────────────────────────────────────────────────

  /** 创建根 Turn，并返回贯穿 LLM 与工具执行的取消信号。 */
  startTurn(input: StartTurnInput): { turn: Turn; signal: AbortSignal } {
    if (this.deletingSessions.has(input.sessionId)) {
      throw new Error(`session_deleting: ${input.sessionId}`);
    }
    if (this.registry.isRunning(input.sessionId)) {
      throw new Error('session_busy: a turn is already running for this session');
    }

    // created_at 严格递增，保证分页和"之后"的语义唯一。
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
      createdAt:    now,
    });
    this.turnsRepo.setRunning(turnId);
    this.sessionsRepo.touchActivity(input.sessionId, now);

    const signal = this.registry.register(input.sessionId, turnId);
    return { turn: this.requireTurn(turnId), signal };
  }
  completeTurn(turnId: TurnId, usage: CompleteTurnInput = {}): void {
    this.requireTurn(turnId);
    this.turnsRepo.complete(turnId, {
      status:             'completed',
      completedAt:        Date.now(),
      usageInputTokens:   usage.usageInputTokens,
      usageOutputTokens:  usage.usageOutputTokens,
      iterations:         usage.iterations,
    });
  }

  failTurn(turnId: TurnId, errorCode: string, errorMessage?: string): void {
    this.requireTurn(turnId);
    this.turnsRepo.complete(turnId, {
      status:       'failed',
      completedAt:  Date.now(),
      errorCode,
      errorMessage,
    });
  }

  /** 触发取消信号并提交 Turn 的 aborted 终态。 */
  abortTurn(sessionId: SessionId, turnId: TurnId): void {
    this.assertTurnOwnership(sessionId, turnId);
    const activeTurnId = this.registry.getActiveTurnId(sessionId);
    if (activeTurnId !== turnId) {
      throw new Error(`turn_not_active: ${turnId}`);
    }
    this.registry.abort(sessionId, turnId);
    this.turnsRepo.complete(turnId, {
      status:      'aborted',
      completedAt: Date.now(),
    });
  }

  /**
   * 只请求正在运行的执行流停止，不提前写数据库终态。执行流会先收拢工具和
   * Subagent，再由对应生命周期 Facade 提交 aborted/cancelled。
   */
  requestAbort(sessionId: SessionId, turnId: TurnId): void {
    this.registry.abort(sessionId, turnId);
  }

  /** 只释放指定 Turn 的运行锁，迟到 finally 不得清掉同 Session 的后继 Turn。 */
  clearRunning(sessionId: SessionId, turnId: TurnId): void {
    this.registry.clear(sessionId, turnId);
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

  /** Server 通过活动数量变化及时抢占低优先级维护，不需要轮询 Session。 */
  subscribeActiveTurns(listener: (activeCount: number) => void): () => void {
    return this.registry.subscribe(listener);
  }

  listTurns(sessionId: SessionId, limit = 50): Turn[] {
    return this.history.listTurns(sessionId, limit);
  }

  /** 为长 Session 提供不含消息正文的轻量 Turn 导航索引。 */
  listTurnIndex(
    sessionId: SessionId,
    input: ListTurnIndexInput = {},
  ): TurnIndexPage {
    return this.history.listTurnIndex(sessionId, input);
  }

  /** 按 Turn 边界读取旧消息窗口，避免把整个 Session 的正文一次载入内存。 */
  listMessageWindow(
    sessionId: SessionId,
    input: ListMessageWindowInput,
  ): MessageWindow {
    return this.history.listMessageWindow(sessionId, input);
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
    return this.history.listTurnIdsPage(sessionId, cursor, limit);
  }

  /** 校验 turn 属于指定 session；跨模块写入前的归属防线。 */
  assertTurnOwnership(sessionId: SessionId, turnId: TurnId): void {
    const turn = this.requireTurn(turnId);
    if (turn.sessionId !== sessionId) {
      throw new SessionOwnershipError(
        `turn ${turnId} belongs to session ${turn.sessionId}, not ${sessionId}`,
      );
    }
  }

  /** 校验 message 属于指定 session；不向调用方暴露仓储。 */
  assertMessageOwnership(sessionId: SessionId, messageId: MessageId): void {
    const message = this.requireMessage(messageId);
    if (message.sessionId !== sessionId) {
      throw new SessionOwnershipError(
        `message ${messageId} belongs to session ${message.sessionId}, not ${sessionId}`,
      );
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
      turnId:      input.turnId ?? undefined,
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
  loadHistory(sessionId: SessionId, limit?: number): Message[] {
    return this.history.loadHistory(sessionId, limit);
  }

  /** 加载一个 Turn 的全部消息，供 Turn 后处理使用。 */
  loadMessagesForTurn(turnId: TurnId): Message[] {
    return this.history.loadMessagesForTurn(turnId);
  }

  /** 启动恢复按 Tool Call ID 找回模型原始调用与已经落库的结果。 */
  findToolInteraction(
    turnId: TurnId,
    callId: string,
  ): PersistedToolInteraction | undefined {
    let interaction: PersistedToolInteraction | undefined;
    for (const message of this.loadMessagesForTurn(turnId)) {
      if (!Array.isArray(message.blocks)) continue;
      if (message.role === 'assistant') {
        const call = message.blocks.find(block => (
          typeof block === 'object'
          && block !== null
          && 'type' in block
          && block.type === 'tool_use'
          && block.id === callId
        ));
        if (call?.type === 'tool_use') {
          interaction = { name: call.name, args: call.args };
        }
        continue;
      }
      if (!interaction || message.kind !== 'tool_results') continue;
      const result = message.blocks.find(block => (
        typeof block === 'object'
        && block !== null
        && 'type' in block
        && block.type === 'tool_result'
        && block.toolCallId === callId
      ));
      if (result?.type === 'tool_result') interaction.result = result;
    }
    return interaction;
  }

  /** 兼容现有聊天页的时间游标读取，结果保持最新优先。 */
  listMessages(sessionId: SessionId, input: ListMessagesInput = {}): Message[] {
    return this.history.listMessages(sessionId, input);
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
