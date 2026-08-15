// Turn 生命周期、进程内运行态（取消信号/运行锁/删除守卫）与导航查询。
// 面向 storage repo 工作，不 import session 包；AbortSignal 只活在内存，
// 崩溃恢复以 SQLite 的 turns.status 为事实源。

import crypto from 'node:crypto';
import {
  MessagesRepo,
  SessionsRepo,
  TurnsRepo,
  type Database,
  type TurnIdPage,
  type TurnIdPageCursor,
  type TurnRow,
} from '@ema-agent/storage';
import { type SessionId, type TurnId, asTurnId } from '@ema-agent/ids';
import type {
  CompleteTurnInput,
  ListTurnIndexInput,
  ListTurnWindowInput,
  StartTurnInput,
  Turn,
  TurnIndexPage,
  TurnWindow,
} from './turns.js';
import { ActiveTurnRegistry } from './activeTurnRegistry.js';
import { TurnOwnershipError } from './errors.js';

export interface TurnStoreDeps {
  db: Database;
  /** 最后一轮重发成功回滚后，清理该 Turn 派生的音频和临时文件。 */
  onTurnRemoved?: (sessionId: string, turnId: string) => void;
}

/** 管理 Turn 聚合；同一 Session 同一时刻只允许一个根 Turn 运行。 */
export class TurnStore {
  private readonly sessionsRepo: SessionsRepo;
  private readonly turnsRepo:    TurnsRepo;
  private readonly messagesRepo: MessagesRepo;
  private readonly db:           Database;
  private readonly onTurnRemoved?: (sessionId: string, turnId: string) => void;
  private readonly deletingSessions = new Set<string>();
  /** 进程内活动根 Turn 表；运行态只用于快速判断和取消，崩溃恢复以 SQLite 终态为准。 */
  private readonly registry = new ActiveTurnRegistry();
  /** 单调时间戳避免同毫秒写入破坏游标边界。 */
  private lastTs = 0;

  constructor({ db, onTurnRemoved }: TurnStoreDeps) {
    this.sessionsRepo = new SessionsRepo(db.sqlite);
    this.turnsRepo    = new TurnsRepo(db.sqlite);
    this.messagesRepo = new MessagesRepo(db.sqlite);
    this.db           = db;
    this.onTurnRemoved = onTurnRemoved;
  }

  /** 返回严格递增的进程内时间戳。 */
  private nextTs(): number {
    const now = Date.now();
    this.lastTs = now > this.lastTs ? now : this.lastTs + 1;
    return this.lastTs;
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

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

    this.requireSessionRow(input.sessionId);
    const turnId = input.turnId ?? asTurnId(crypto.randomUUID());
    this.turnsRepo.insert({
      id:           turnId,
      sessionId:    input.sessionId,
      triggerType:  input.triggerType,
      executionProfile: input.executionProfile,
      narrativePolicy:  input.narrativePolicy,
      createdAt:    now,
    });
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

  /** 提交 failed 终态；失败前已产生的迭代与 token 用量仍是真实事实，随终态一起写入。 */
  failTurn(
    turnId: TurnId,
    failure: { errorCode: string; errorMessage?: string; usage?: CompleteTurnInput },
  ): void {
    this.requireTurn(turnId);
    this.turnsRepo.complete(turnId, {
      status:       'failed',
      completedAt:  Date.now(),
      errorCode:    failure.errorCode,
      errorMessage: failure.errorMessage,
      ...failure.usage,
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
   * 只请求停止、不写终态。调用方是 Session 删除协调等系统路径：它们没有资格
   * 提交 Turn 终态，只发信号；执行流收拢工具和 Subagent 后由自己提交
   * aborted/cancelled，避免协调层与执行器双写终态。用户主动取消走 abortTurn。
   */
  requestAbort(sessionId: SessionId, turnId: TurnId): void {
    this.registry.abort(sessionId, turnId);
  }

  /** 只释放指定 Turn 的运行锁，迟到 finally 不得清掉同 Session 的后继 Turn。 */
  clearRunning(sessionId: SessionId, turnId: TurnId): void {
    this.registry.clear(sessionId, turnId);
  }

  /** 启动时将崩溃遗留的 running Turn 收口为 aborted。 */
  recoverStuckTurns(): { healed: number } {
    const healed = this.turnsRepo.abortAllStale(Date.now());
    return { healed };
  }

  // ── 运行态读取 ──────────────────────────────────────────────────────────────

  getTurn(id: TurnId): Turn | undefined {
    const row = this.turnsRepo.findById(id);
    return row ? toTurn(row) : undefined;
  }

  getActiveTurn(sessionId: SessionId): Turn | undefined {
    const turnId = this.registry.getActiveTurnId(sessionId);
    return turnId ? this.getTurn(turnId) : undefined;
  }

  /** 后台派生缓存只在所有前台 Turn 都结束后执行维护。 */
  hasActiveTurns(): boolean {
    return this.registry.activeSessionCount() > 0;
  }

  /** Server 通过活动数量变化及时抢占低优先级维护，不需要轮询 Session。 */
  subscribeActiveTurns(listener: (activeCount: number) => void): () => void {
    return this.registry.subscribe(listener);
  }

  // ── Session 删除守卫 ────────────────────────────────────────────────────────

  /**
   * 删除协调开始后立刻阻止该 Session 的新 Turn，并向当前根 Turn 发出取消信号。
   * 活动表只覆盖"正在跑"的 Turn；删除窗口内（运行中 Turn 已中止、数据库行还没删）
   * 新的用户输入仍可能到达，没有这个守卫就会在被删除的 Session 上再开一轮。
   */
  beginSessionDeletion(id: SessionId): void {
    this.requireSessionRow(id);
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

  /** Session 行删除后丢弃其运行态条目；普通 Turn 终态不得使用该入口。 */
  discardSession(id: SessionId): void {
    this.registry.discardSession(id);
    this.deletingSessions.delete(id);
  }

  // ── 导航查询 ────────────────────────────────────────────────────────────────

  listTurns(sessionId: SessionId, limit = 50): Turn[] {
    return this.turnsRepo.listForSession(sessionId, limit).map(toTurn);
  }

  /** 为长 Session 提供不含消息正文的轻量 Turn 导航索引。 */
  listTurnIndex(
    sessionId: SessionId,
    input: ListTurnIndexInput = {},
  ): TurnIndexPage {
    this.requireSessionRow(sessionId);
    const limit = normaliseIntegerLimit(
      input.limit,
      TURN_INDEX_DEFAULT_LIMIT,
      TURN_INDEX_MAX_LIMIT,
      'turn_index_limit',
    );
    const cursor = input.cursor ? decodeTurnIndexCursor(input.cursor) : undefined;
    const page = this.turnsRepo.listForSessionPage(sessionId, cursor, limit);

    return {
      items: page.rows.map((row) => ({
        turnId: row.id as TurnId,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        status: row.status,
        triggerType: row.trigger_type,
        executionProfile: row.execution_profile,
        preview: formatTurnPreview(row.preview),
      })),
      nextCursor: page.nextCursor ? encodeTurnIndexCursor(page.nextCursor) : undefined,
    };
  }

  /**
   * 按锚点 Turn 读取前后有界窗口（旧到新）。消息正文由 SessionStore
   * 按窗口内 turnIds 另取，拼装层（Server 路由）合成完整窗口。
   */
  listTurnWindow(sessionId: SessionId, input: ListTurnWindowInput): TurnWindow {
    this.requireSessionRow(sessionId);
    this.assertTurnOwnership(sessionId, input.anchorTurnId);
    const beforeTurns = normaliseIntegerLimit(
      input.beforeTurns,
      TURN_WINDOW_DEFAULT_BEFORE,
      TURN_WINDOW_MAX_SIDE,
      'turn_window_before',
      true,
    );
    const afterTurns = normaliseIntegerLimit(
      input.afterTurns,
      TURN_WINDOW_DEFAULT_AFTER,
      TURN_WINDOW_MAX_SIDE,
      'turn_window_after',
      true,
    );
    if (beforeTurns + afterTurns > TURN_WINDOW_MAX_TOTAL) {
      throw new Error('turn_window_too_large');
    }

    const window = this.turnsRepo.listWindowAround(
      sessionId,
      input.anchorTurnId,
      beforeTurns,
      afterTurns,
    );
    if (!window) throw new Error(`turn_not_found: ${input.anchorTurnId}`);

    return {
      anchorTurnId: input.anchorTurnId,
      turns: window.rows.map(toTurn),
      hasOlder: window.hasOlder,
      hasNewer: window.hasNewer,
    };
  }

  /** 启动恢复等内部任务使用的轻量 Turn ID 游标页，不加载正文和其他领域对象。 */
  listTurnIdsPage(
    sessionId: SessionId,
    cursor?: TurnIdPageCursor,
    limit = 1_000,
  ): TurnIdPage {
    return this.turnsRepo.listIdsForSessionPage(sessionId, cursor, limit);
  }

  // ── 回滚 ────────────────────────────────────────────────────────────────────

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
    if (latest.status === 'running') {
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

  /** 校验 turn 属于指定 session；跨模块写入前的归属防线。 */
  assertTurnOwnership(sessionId: SessionId, turnId: TurnId): void {
    const turn = this.requireTurn(turnId);
    if (turn.sessionId !== sessionId) {
      throw new TurnOwnershipError(
        `turn ${turnId} belongs to session ${turn.sessionId}, not ${sessionId}`,
      );
    }
  }

  // ── 归属读取与监听器 ─────────────────────────────────────────────────────────

  private requireSessionRow(id: SessionId): void {
    if (!this.sessionsRepo.findById(id)) {
      throw new Error(`session_not_found: ${id}`);
    }
  }

  private requireTurn(id: TurnId): Turn {
    const row = this.turnsRepo.findById(id);
    if (!row) throw new Error(`turn_not_found: ${id}`);
    return toTurn(row);
  }
}

// ── 行映射与查询辅助 ──────────────────────────────────────────────────────────

function toTurn(row: TurnRow): Turn {
  return {
    id: row.id as TurnId,
    sessionId: row.session_id as SessionId,
    status: row.status,
    triggerType: row.trigger_type,
    executionProfile: row.execution_profile,
    narrativePolicy: row.narrative_policy,
    providerConfigId: row.provider_config_id,
    modelId: row.model_id,
    iterations: row.iterations,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

const TURN_INDEX_DEFAULT_LIMIT = 200;
const TURN_INDEX_MAX_LIMIT = 500;
const TURN_INDEX_PREVIEW_LENGTH = 180;
const TURN_WINDOW_DEFAULT_BEFORE = 8;
const TURN_WINDOW_DEFAULT_AFTER = 12;
const TURN_WINDOW_MAX_SIDE = 25;
const TURN_WINDOW_MAX_TOTAL = 40;

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
    a: cursor.createdAt,
    i: cursor.id,
  }), 'utf8').toString('base64url');
}

function decodeTurnIndexCursor(value: string): TurnIdPageCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as { a?: unknown; i?: unknown };
    if (
      !Number.isSafeInteger(parsed.a)
      || typeof parsed.i !== 'string'
      || parsed.i.length === 0
    ) {
      throw new Error('invalid');
    }
    return { createdAt: parsed.a as number, id: parsed.i };
  } catch {
    throw new Error('Invalid turn index cursor');
  }
}
