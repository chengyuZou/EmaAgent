// 同 Session 串行、跨 Session 并行的统一交互队列；Permission 与 AskUser 按进入顺序共同排队。
import type {
  PendingPermissionRequest,
  PermissionRequest,
  PermissionResponse,
} from '@ema-agent/permission';
import type {
  AskUserRequiredEvent,
  PendingAskUserPrompt,
} from '@ema-agent/tools';

// ── 联合交互类型 ─────────────────────────────────────────────────────────────

/** Permission 交互条目；三身份含于 PermissionRequest 内，条目不再重复携带。 */
export interface PermissionInteraction {
  readonly kind:        'permission';
  readonly createdAt:   number;
  readonly timeoutMs:   number | null;
  readonly request:     PermissionRequest;
  readonly resolve:     (response: PermissionResponse) => void;
}

/** AskUser 交互条目；三身份含于 AskUserRequiredEvent 内。 */
export interface AskUserInteraction {
  readonly kind:        'askUser';
  readonly createdAt:   number;
  readonly timeoutMs:   number | null;
  readonly request:     AskUserRequiredEvent;
  readonly resolve:     (outcome: AskUserInteractionOutcome) => void;
}

/** 统一队列承载的两种业务 Payload；kind 区分 resolve 签名。 */
export type SessionInteraction = PermissionInteraction | AskUserInteraction;

/** AskUser 的明确终态；取消和超时不能伪装成用户提交了空答案。 */
export type AskUserInteractionOutcome =
  | { readonly status: 'answered'; readonly answers: Readonly<Record<string, string>> }
  | { readonly status: 'cancelled'; readonly reason: string }
  | { readonly status: 'timed_out'; readonly reason: string };

/**
 * listPending 返回的可恢复快照；不暴露 Promise 与 timer。
 * 形状复用拥有方（permission/tools）各自的 Pending 投影，队列只加 kind 判别。
 */
export type PendingInteraction =
  | ({ readonly kind: 'permission' } & PendingPermissionRequest)
  | ({ readonly kind: 'askUser' }    & PendingAskUserPrompt);

// ── 内部 FIFO ────────────────────────────────────────────────────────────────

/** 单个 Session 的 FIFO；entries[0] 是队首，只有队首持有活动 timer。 */
interface SessionFifo {
  entries: SessionInteraction[];
  timer:   ReturnType<typeof setTimeout> | undefined;
}

// ── SessionInteractionQueue ─────────────────────────────────────────────────

/**
 * 内存交互队列。Process-local，无持久化——Turn abort 或进程重启取消全部待交互
 * （Permission 以 deny resolve，AskUser 以明确取消终态 resolve，使等待方干净退出）。
 *
 * 语义：
 *   - 同一 Session 严格 FIFO：Permission 与 AskUser 按进入顺序共同排队，队首活跃并
 *     独占超时计时；队首之外的条目排队等待，不计时。队首 resolve/cancel/超时后，
 *     下一个条目升为队首才开始自己的超时。
 *   - 不同 Session 互相独立，可并行等待用户。
 *   - 响应按 toolCallId 查址（全局唯一）：一次交互永远由唯一一次 Tool 调用触发，
 *     Permission 锚 = 触发审批的调用，AskUser 锚 = 发起问询的调用。
 *   - listPending(sessionId?) 供 SSE 重连恢复指定 Session 的队列快照。
 */
export class SessionInteractionQueue {
  private readonly sessions = new Map<string, SessionFifo>();
  /** toolCallId → { fifo, entry }，O(1) 定位 respond/cancel。 */
  private readonly index = new Map<string, { fifo: SessionFifo; entry: SessionInteraction }>();
  private defaultTimeoutMs: number | null;

  constructor(defaultTimeoutMs: number | null) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /** 实时更新默认超时（供 permission-ask-timeout 设置）。只影响此后新建的条目。 */
  setDefaultTimeout(ms: number | null): void {
    this.defaultTimeoutMs = ms;
  }

  /**
   * 预约一个 Permission 审批槽。请求本体即 PermissionRequest（锚点 toolCallId 与
   * 身份含于其中，由 Tool 执行链装配）；返回在用户响应或超时后 resolve 的 Promise。
   * 若该 Session 队列为空，新条目立即成为队首并开始超时；否则排队，等升为队首才计时。
   */
  enqueuePermission(
    request: PermissionRequest,
    timeoutMs?: number | null,
  ): { createdAt: number; promise: Promise<PermissionResponse> } {
    const createdAt = Date.now();
    let resolve!: (response: PermissionResponse) => void;
    const promise = new Promise<PermissionResponse>(r => { resolve = r; });

    this.pushEntry({
      kind:      'permission',
      createdAt,
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
      request,
      resolve,
    });
    return { createdAt, promise };
  }

  /**
   * 预约一个 AskUser 问询槽。请求本体即已发出的 ask_user_required 事件；
   * 返回在用户回答或超时后 resolve 的 Promise。
   */
  enqueueAskUser(
    request: AskUserRequiredEvent,
    timeoutMs?: number | null,
  ): { createdAt: number; promise: Promise<AskUserInteractionOutcome> } {
    const createdAt = Date.now();
    let resolve!: (outcome: AskUserInteractionOutcome) => void;
    const promise = new Promise<AskUserInteractionOutcome>(r => { resolve = r; });

    this.pushEntry({
      kind:      'askUser',
      createdAt,
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
      request,
      resolve,
    });
    return { createdAt, promise };
  }

  /** 用用户响应解决一条 Permission 待审批；同时核对 Turn，防止陈旧卡片误答。 */
  respondPermission(
    toolCallId: string,
    response: PermissionResponse,
    expectedTurnId?: string,
  ): boolean {
    const record = this.index.get(toolCallId);
    if (!record || record.entry.kind !== 'permission') return false;
    if (record.fifo.entries[0] !== record.entry) return false;
    if (expectedTurnId !== undefined && record.entry.request.turnId !== expectedTurnId) return false;
    return this.evict(toolCallId, response);
  }

  /** 用用户答案解决一条 AskUser 问询；toolCallId 未知或已解决时返回 false。 */
  respondAskUser(
    toolCallId: string,
    answers: Record<string, string>,
    expectedTurnId?: string,
  ): boolean {
    const record = this.index.get(toolCallId);
    if (!record || record.entry.kind !== 'askUser') return false;
    if (record.fifo.entries[0] !== record.entry) return false;
    if (expectedTurnId !== undefined && record.entry.request.turnId !== expectedTurnId) return false;
    return this.evict(toolCallId, { status: 'answered', answers });
  }

  /** 只允许 Permission 路由取消匹配 Turn 的活动 Permission 队首。 */
  cancelPermission(
    toolCallId: string,
    reason = 'cancelled',
    expectedTurnId?: string,
  ): boolean {
    return this.cancelActiveByKind('permission', toolCallId, reason, expectedTurnId);
  }

  /** 只允许 AskUser 路由取消匹配 Turn 的活动 AskUser 队首。 */
  cancelAskUser(
    toolCallId: string,
    reason = 'cancelled',
    expectedTurnId?: string,
  ): boolean {
    return this.cancelActiveByKind('askUser', toolCallId, reason, expectedTurnId);
  }

  /**
   * 用户只能取消类型和 Turn 均匹配的活动队首。Turn/Session 生命周期清理
   * 继续使用 cancel()/cancelForTurn()/cancelForSession()，不经过路由限制。
   */
  private cancelActiveByKind(
    kind: 'permission' | 'askUser',
    id: string,
    reason: string,
    expectedTurnId?: string,
  ): boolean {
    const record = this.index.get(id);
    if (!record || record.fifo.entries[0] !== record.entry) return false;
    if (record.entry.kind !== kind) return false;
    if (expectedTurnId !== undefined && record.entry.request.turnId !== expectedTurnId) return false;
    return this.cancel(id, reason);
  }

  /**
   * 不带真实响应地取消一条（用于 turn abort）。按 kind resolve：
   * permission→deny，askUser→cancelled。使等待方干净退出。
   */
  cancel(id: string, reason = 'cancelled'): boolean {
    const record = this.index.get(id);
    if (!record) return false;
    if (record.entry.kind === 'permission') {
      return this.evict(id, { action: 'deny', reason });
    }
    return this.evict(id, { status: 'cancelled', reason });
  }

  /** 取消某 Turn 的全部待交互（turn abort 时用）。 */
  cancelForTurn(turnId: string, reason = 'turn aborted'): number {
    const ids = [...this.index.values()]
      .filter(({ entry }) => entry.request.turnId === turnId)
      .map(({ entry }) => entry.request.toolCallId);
    let n = 0;
    for (const id of ids) {
      if (this.cancel(id, reason)) n++;
    }
    return n;
  }

  /** Session 删除时取消其全部待交互，避免悬挂 Promise。 */
  cancelForSession(sessionId: string, reason = 'session deleted'): number {
    const fifo = this.sessions.get(sessionId);
    if (!fifo) return 0;
    const ids = fifo.entries.map(entry => entry.request.toolCallId);
    for (const id of ids) {
      this.cancel(id, reason);
    }
    return ids.length;
  }

  /** 诊断：在飞条目总数。 */
  size(): number {
    return this.index.size;
  }

  /**
   * 返回可恢复的待交互快照（不暴露 Promise 与 timer）。
   * 传 sessionId 时只返回该 Session 的 FIFO（队首在前）；不传时返回全部，按 createdAt 升序。
   */
  listPending(sessionId?: string): PendingInteraction[] {
    if (sessionId) {
      const fifo = this.sessions.get(sessionId);
      if (!fifo) return [];
      return fifo.entries.map(toPending);
    }
    return [...this.index.values()]
      .map(({ entry }) => toPending(entry))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // ── 内部 ───────────────────────────────────────────────────────────────────

  /** 把条目推入对应 Session FIFO；若队列为空，新条目立即成为队首并开始计时。 */
  private pushEntry(entry: SessionInteraction): void {
    const id = entry.request.toolCallId;
    if (this.index.has(id)) {
      throw new Error(`Duplicate interaction id: ${id}`);
    }
    let fifo = this.sessions.get(entry.request.sessionId);
    if (!fifo) {
      fifo = { entries: [], timer: undefined };
      this.sessions.set(entry.request.sessionId, fifo);
    }
    const wasEmpty = fifo.entries.length === 0;
    fifo.entries.push(entry);
    this.index.set(id, { fifo, entry });
    if (wasEmpty) {
      this.startHeadTimer(fifo);
    }
  }

  /**
   * 启动 fifo 队首的超时计时。调用前需保证 fifo.entries[0] 存在且旧 timer 已清。
   * 队首超时后以默认终态 resolve（permission→deny，askUser→timed_out），并让下一个
   * 条目升为队首继续计时。
   */
  private startHeadTimer(fifo: SessionFifo): void {
    if (fifo.timer) clearTimeout(fifo.timer);
    const head = fifo.entries[0];
    if (!head) {
      fifo.timer = undefined;
      return;
    }
    if (head.timeoutMs === null) {
      fifo.timer = undefined;
      return;
    }
    fifo.timer = setTimeout(() => {
      const reason = `timed out after ${head.timeoutMs}ms`;
      const id = head.request.toolCallId;
      if (head.kind === 'permission') {
        this.evict(id, { action: 'deny', reason });
      } else {
        this.evict(id, { status: 'timed_out', reason });
      }
    }, head.timeoutMs);
  }

  /**
   * 把 id 对应条目移出 fifo 并 resolve。
   * 若移除的是队首，清理 timer 并让下一个升为队首开始计时；若队列空，移除 SessionFifo。
   */
  private evict(
    id: string,
    payload: PermissionResponse | AskUserInteractionOutcome,
  ): boolean {
    const record = this.index.get(id);
    if (!record) return false;
    const { fifo, entry } = record;
    const wasHead = fifo.entries[0] === entry;

    if (wasHead && fifo.timer) {
      clearTimeout(fifo.timer);
      fifo.timer = undefined;
    }
    fifo.entries = fifo.entries.filter(e => e !== entry);
    this.index.delete(id);
    if (entry.kind === 'permission') {
      entry.resolve(payload as PermissionResponse);
    } else {
      entry.resolve(payload as AskUserInteractionOutcome);
    }

    if (fifo.entries.length === 0) {
      this.sessions.delete(entry.request.sessionId);
    } else if (wasHead) {
      // 队首被移除，新的队首开始自己的超时。
      this.startHeadTimer(fifo);
    }
    return true;
  }
}

/** 把内部条目投影为可恢复快照，剥离 Promise 与 timer。 */
function toPending(entry: SessionInteraction): PendingInteraction {
  if (entry.kind === 'permission') {
    return {
      kind:       'permission',
      toolCallId: entry.request.toolCallId,
      createdAt:  entry.createdAt,
      request:    entry.request,
    };
  }
  return {
    kind:      'askUser',
    createdAt: entry.createdAt,
    request:   entry.request,
  };
}
