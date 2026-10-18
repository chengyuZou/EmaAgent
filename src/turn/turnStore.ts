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
import { SessionBusyError, SessionRunningRegistry, SessionWorkBlockedError } from '@ema-agent/session';
import type {
  ListTurnIndexInput,
  StartTurnInput,
  Turn,
  TurnIndexPage,
} from './types.js';
import { TurnOwnershipError } from './errors.js';

export interface TurnStoreDeps {
  db: Database;
  /** 最后一轮重发成功回滚后,清理该 Turn 派生的音频和临时文件. */
  onTurnRemoved?: (sessionId: string, turnId: string) => void;
  /**
   * 记录 Session 当前正在运行的 Turn 或手动 Compact, 两者不能同时开始.
   * 由 Server Composition 构造并与 Commands 共享同一实例; TurnStore 只注册 kind='turn'.
   */
  sessionRunning: SessionRunningRegistry;
}

/** 管理 Turn 记录; 同一 Session 同一时刻只允许一个 Turn 运行. */
export class TurnStore {
  private readonly sessionsRepo: SessionsRepo;
  private readonly turnsRepo:    TurnsRepo;
  private readonly messagesRepo: MessagesRepo;
  private readonly db:           Database;
  private readonly onTurnRemoved?: (sessionId: string, turnId: string) => void;
  /** 进程内活跃执行表;运行态只用于快速判断和取消,崩溃恢复以 SQLite 终态为准. */
  private readonly registry: SessionRunningRegistry;
  /** 单调时间戳避免同毫秒写入破坏游标边界. */
  private lastTs = 0;

  constructor({ db, onTurnRemoved, sessionRunning }: TurnStoreDeps) {
    this.sessionsRepo = new SessionsRepo(db.sqlite);
    this.turnsRepo    = new TurnsRepo(db.sqlite);
    this.messagesRepo = new MessagesRepo(db.sqlite);
    this.db           = db;
    this.onTurnRemoved = onTurnRemoved;
    this.registry     = sessionRunning;
  }

  /** 返回严格递增的进程内时间戳. */
  private nextTs(): number {
    const now = Date.now();
    this.lastTs = now > this.lastTs ? now : this.lastTs + 1;
    return this.lastTs;
  }


  /** 创建 Turn, 并返回贯穿 LLM 与工具执行的取消信号. */
  startTurn(input: StartTurnInput): { turn: Turn; signal: AbortSignal } {
    this.registry.assertWorkAllowed(input.sessionId);
    const session = this.sessionsRepo.findById(input.sessionId);
    if (!session) {
      throw new Error(`session_not_found: ${input.sessionId}`);
    }
    if (session.archived_at !== null) {
      throw new SessionWorkBlockedError('session_archived', input.sessionId);
    }
    if (this.registry.isRunning(input.sessionId)) {
      throw new SessionBusyError(input.sessionId);
    }

    // created_at 严格递增,保证分页和"之后"的语义唯一.
    const now = this.nextTs();

    // 进程内没有活跃执行后, 把同一 Session 的遗留 running 行改为 aborted.
    this.turnsRepo.abortStale(input.sessionId, now);

    const turnId = input.turnId ?? crypto.randomUUID();
    this.turnsRepo.insert({
      id:           turnId,
      sessionId:    input.sessionId,
      triggerType:  input.triggerType,
      ttsEnabled: input.ttsEnabled,
      createdAt:    now,
    });
    this.sessionsRepo.touchActivity(input.sessionId, now);

    const signal = this.registry.register(input.sessionId, { kind: 'turn', turnId });
    return { turn: this.requireTurn(turnId), signal };
  }

  /** 输入准备解析出模型身份与实际调用协议后回填;只能在终态前调用一次的事实修正. */
  setModel(turnId: string, providerId: string, modelId: string, protocol: string): void {
    this.turnsRepo.setModel(turnId, providerId, modelId, protocol);
  }

  /** Prepare 完成时冻结 Character.name. Memory 提取经 turnId 回读. */
  setCharacterName(turnId: string, characterName: string): void {
    this.turnsRepo.setCharacterName(turnId, characterName);
  }

  completeTurn(
    turnId: string,
    withinTransaction?: () => void,
  ): void {
    this.requireTurn(turnId);
    // 终态与派生登记(如 Memory 提取入队)同一事务:崩溃不允许出现
    // "Turn 已完成但提取 Job 缺失"的裂缝.
    this.db.sqlite.transaction(() => {
      this.turnsRepo.complete(turnId, {
        status:             'completed',
        completedAt:        Date.now(),
      });
      withinTransaction?.();
    })();
    // 终态行不等于执行收尾结束. 运行占用由 TurnExecutor 收完消息和工具后释放.
  }

  /** 提交 failed 终态;失败前已持久化的迭代与调用级用量保持不变. */
  failTurn(
    turnId: string,
    failure: { errorCode: string; errorMessage?: string },
  ): void {
    this.requireTurn(turnId);
    this.turnsRepo.complete(turnId, {
      status:       'failed',
      completedAt:  Date.now(),
      errorCode:    failure.errorCode,
      errorMessage: failure.errorMessage,
    });
  }

  /** 触发取消信号并提交 Turn 的 aborted 终态. */
  abortTurn(sessionId: string, turnId: string): void {
    this.assertTurnOwnership(sessionId, turnId);
    const running = this.registry.getRunning(sessionId);
    if (running?.kind !== 'turn' || running.turnId !== turnId) {
      throw new Error(`turn_not_active: ${turnId}`);
    }
    this.registry.abort(sessionId, running);
    this.turnsRepo.complete(turnId, {
      status:      'aborted',
      completedAt: Date.now(),
    });
  }

  /**
   * 只发取消信号, 由 TurnExecutor 写入终态并完成工具和消息清理.
   * 直接写 aborted 不等于执行已退出, Session 删除仍需等待 completion.
   */
  requestAbort(sessionId: string, turnId: string): void {
    this.registry.abort(sessionId, { kind: 'turn', turnId });
  }

  /** 只释放指定 Turn 的运行锁,迟到 finally 不得清掉同 Session 的后继 Turn. */
  clearRunning(sessionId: string, turnId: string): void {
    this.registry.clear(sessionId, { kind: 'turn', turnId });
  }

  /** 每次开始模型迭代时保存次数, 失败和取消仍保留已经发生的迭代. */
  setIterations(turnId: string, iterations: number): void {
    this.turnsRepo.setIterations(turnId, iterations);
  }

  /** 启动时将崩溃遗留的 running Turn 改为 aborted. */
  recoverStuckTurns(): { healed: number } {
    const healed = this.turnsRepo.abortAllStale(Date.now());
    return { healed };
  }


  getTurn(id: string): Turn | undefined {
    const row = this.turnsRepo.findById(id);
    return row ? toTurn(row) : undefined;
  }

  listSummaries(sessionId: string, cursor: TurnIdPageCursor | undefined, limit: number) {
    const page = this.turnsRepo.listSummaries(sessionId, cursor, limit);
    return {
      items: page.rows.map(row => ({
        id: row.id,
        sessionId: row.session_id,
        status: row.status,
        triggerType: row.trigger_type,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        messageCount: row.message_count,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
      nextCursor: page.nextCursor,
    };
  }

  getRunningTurn(sessionId: string): Turn | undefined {
    const running = this.registry.getRunning(sessionId);
    return running?.kind === 'turn' ? this.getTurn(running.turnId) : undefined;
  }

  /** Session 行删除后丢弃其运行态条目;普通 Turn 终态不得使用该入口. */
  discardSession(id: string): void {
    this.registry.discardSession(id);
  }


  /** 为长 Session 提供不含消息正文的轻量 Turn 导航索引. */
  listTurnIndex(
    sessionId: string,
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
        turnId: row.id,
        anchorMessageId: row.anchor_message_id,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        status: row.status,
        triggerType: row.trigger_type,
        preview: formatTurnPreview(row.preview),
      })),
      nextCursor: page.nextCursor ? encodeTurnIndexCursor(page.nextCursor) : undefined,
    };
  }

  /** 启动恢复等内部任务使用的轻量 Turn ID 游标页,不加载正文和其他领域对象. */
  listTurnIdsPage(
    sessionId: string,
    cursor?: TurnIdPageCursor,
    limit = 1_000,
  ): TurnIdPage {
    return this.turnsRepo.listIdsForSessionPage(sessionId, cursor, limit);
  }


  /**
   * 删除一个 Session 的最后一整个 Turn.当前 UI 禁止消息回退;此入口仅保留给后端,
   * TODO: 若未来恢复消息编辑,先设计 Message 级截断语义,不能把整 Turn 删除伪装成消息回退.
   */
  rewindLastTurn(sessionId: string, turnId: string): { turnId: string } {
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

    // Task.created_by_turn_id 使用 RESTRICT;若该轮已创建持久 Task,
    // 整个事务会回滚,避免 UI 看似撤销但 Task 仍悬挂.
    this.db.sqlite.transaction(() => {
      this.messagesRepo.deleteForTurn(turnId);
      this.turnsRepo.delete(turnId);
      this.sessionsRepo.touchActivity(sessionId, this.nextTs());
    })();

    this.onTurnRemoved?.(sessionId as string, turnId as string);
    return { turnId };
  }

  /** 校验 turn 属于指定 session;跨模块写入前的归属防线. */
  assertTurnOwnership(sessionId: string, turnId: string): void {
    const turn = this.requireTurn(turnId);
    if (turn.sessionId !== sessionId) {
      throw new TurnOwnershipError(
        `turn ${turnId} belongs to session ${turn.sessionId}, not ${sessionId}`,
      );
    }
  }


  private requireSessionRow(id: string): void {
    if (!this.sessionsRepo.findById(id)) {
      throw new Error(`session_not_found: ${id}`);
    }
  }

  private requireTurn(id: string): Turn {
    const row = this.turnsRepo.findById(id);
    if (!row) throw new Error(`turn_not_found: ${id}`);
    return toTurn(row);
  }
}


function toTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    triggerType: row.trigger_type,
    ttsEnabled: row.tts_enabled === 1,
    providerId: row.provider_id,
    modelId: row.model_id,
    protocol: row.protocol,
    characterName: row.character_name,
    iterations: row.iterations,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

const TURN_INDEX_DEFAULT_LIMIT = 200;
const TURN_INDEX_MAX_LIMIT = 500;
const TURN_INDEX_PREVIEW_LENGTH = 180;

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
