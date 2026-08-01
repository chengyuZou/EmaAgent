// 同 Session 串行、跨 Session 并行的统一交互队列;Permission 与 AskUser 按进入顺序共同排队。
import { randomUUID } from 'node:crypto';

// ── 联合交互类型 ─────────────────────────────────────────────────────────────

/** Permission 交互条目;resolve 收 PermissionResponse。 */
export interface PermissionInteraction<TPermissionPrompt, TPermissionResponse> {
  readonly kind:        'permission';
  readonly promptId:    string;
  readonly sessionId:   string;
  readonly turnId:      string;
  readonly toolCallId:  string;
  readonly createdAt:   number;
  readonly timeoutMs:   number;
  readonly prompt:      TPermissionPrompt;
  readonly resolve:     (response: TPermissionResponse) => void;
}

/** AskUser 交互条目;resolve 收用户答案。 */
export interface AskUserInteraction<TAskRequest> {
  readonly kind:        'askUser';
  readonly promptId:    string;
  readonly sessionId:   string;
  readonly turnId:      string;
  readonly createdAt:   number;
  readonly timeoutMs:   number;
  readonly request:     TAskRequest;
  readonly resolve:     (outcome: AskUserInteractionOutcome) => void;
}

/** 统一队列承载的两种业务 Payload;共同字段在前,kind 区分 resolve 签名。 */
export type SessionInteraction<TPermissionPrompt, TPermissionResponse, TAskRequest> =
  | PermissionInteraction<TPermissionPrompt, TPermissionResponse>
  | AskUserInteraction<TAskRequest>;

/** AskUser 的明确终态；取消和超时不能伪装成用户提交了空答案。 */
export type AskUserInteractionOutcome =
  | { readonly status: 'answered'; readonly answers: Readonly<Record<string, string>> }
  | { readonly status: 'cancelled'; readonly reason: string }
  | { readonly status: 'timed_out'; readonly reason: string };

/** listPending 返回的可恢复快照;不暴露 Promise 与 timer。 */
export type PendingInteraction<TPermissionPrompt, TAskRequest> =
  | { readonly kind: 'permission'; readonly promptId: string; readonly createdAt: number; readonly prompt: TPermissionPrompt }
  | { readonly kind: 'askUser';    readonly promptId: string; readonly createdAt: number; readonly request: TAskRequest };

// ── 内部 FIFO ────────────────────────────────────────────────────────────────

/** 单个 Session 的 FIFO;entries[0] 是队首,只有队首持有活动 timer。 */
interface SessionFifo<TPermissionPrompt, TPermissionResponse, TAskRequest> {
  entries: SessionInteraction<TPermissionPrompt, TPermissionResponse, TAskRequest>[];
  timer:   ReturnType<typeof setTimeout> | undefined;
}

// ── SessionInteractionQueue ──────────────────────────────────────────────────

/**
 * 内存交互队列。Process-local,无持久化——Turn abort 或进程重启取消全部待交互
 * (Permission 以 deny resolve,AskUser 以明确取消终态 resolve,使等待方干净退出)。
 *
 * 语义:
 *   - 同一 Session 严格 FIFO:Permission 与 AskUser 按进入顺序共同排队,队首活跃并
 *     独占超时计时;队首之外的条目排队等待,不计时。队首 resolve/cancel/超时后,
 *     下一个条目升为队首才开始自己的超时。
 *   - 不同 Session 互相独立,可并行等待用户。
 *   - 响应按全局 promptId 定位(promptId 跨 Session 唯一),不按当前页面或工具名猜。
 *   - listPending(sessionId?) 供 SSE 重连恢复指定 Session 的队列快照。
 */
export class SessionInteractionQueue<TPermissionPrompt, TPermissionResponse, TAskRequest> {
  private readonly sessions =
    new Map<string, SessionFifo<TPermissionPrompt, TPermissionResponse, TAskRequest>>();
  /** promptId → { fifo, entry },O(1) 定位 respond/cancel。 */
  private readonly index = new Map<string, {
    fifo: SessionFifo<TPermissionPrompt, TPermissionResponse, TAskRequest>;
    entry: SessionInteraction<TPermissionPrompt, TPermissionResponse, TAskRequest>;
  }>();
  private defaultTimeoutMs: number;
  private readonly permissionCancellation: (reason: string) => TPermissionResponse;

  constructor(
    defaultTimeoutMs: number,
    permissionCancellation: (reason: string) => TPermissionResponse,
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.permissionCancellation = permissionCancellation;
  }

  /** 实时更新默认超时(供 /api/settings/permission-timeout)。只影响此后新建的条目。 */
  setDefaultTimeout(ms: number): void {
    this.defaultTimeoutMs = ms;
  }

  /**
   * 预约一个 Permission 审批槽。返回全局唯一 promptId 与一个在用户响应或超时后
   * resolve 的 Promise。若该 Session 队列为空,新条目立即成为队首并开始超时;
   * 否则排队,等升为队首才计时。
   */
  enqueuePermission(args: {
    sessionId:  string;
    turnId:     string;
    toolCallId: string;
    prompt:     TPermissionPrompt;
    timeoutMs?: number;
  }): { promptId: string; createdAt: number; promise: Promise<TPermissionResponse> } {
    const promptId   = randomUUID();
    const timeoutMs  = args.timeoutMs ?? this.defaultTimeoutMs;
    const createdAt  = Date.now();

    let resolve!: (response: TPermissionResponse) => void;
    const promise = new Promise<TPermissionResponse>(r => { resolve = r; });

    const entry: PermissionInteraction<TPermissionPrompt, TPermissionResponse> = {
      kind:       'permission',
      promptId,
      resolve,
      sessionId:  args.sessionId,
      turnId:     args.turnId,
      toolCallId: args.toolCallId,
      createdAt,
      timeoutMs,
      prompt:     args.prompt,
    };

    this.pushEntry(entry);
    return { promptId, createdAt, promise };
  }

  /**
   * 预约一个 AskUser 问询槽。promptId 由 Tool 执行链生成并随
   * ask_user_required 事件发出；返回在用户回答或超时后 resolve 的 Promise。
   */
  enqueueAskUser(args: {
    promptId:   string;
    sessionId:  string;
    turnId:     string;
    request:    TAskRequest;
    timeoutMs?: number;
  }): { createdAt: number; promise: Promise<AskUserInteractionOutcome> } {
    const timeoutMs = args.timeoutMs ?? this.defaultTimeoutMs;
    const createdAt = Date.now();

    let resolve!: (outcome: AskUserInteractionOutcome) => void;
    const promise = new Promise<AskUserInteractionOutcome>(r => { resolve = r; });

    const entry: AskUserInteraction<TAskRequest> = {
      kind:       'askUser',
      promptId:   args.promptId,
      resolve,
      sessionId:  args.sessionId,
      turnId:     args.turnId,
      createdAt,
      timeoutMs,
      request:    args.request,
    };

    this.pushEntry(entry);
    return { createdAt, promise };
  }

  /** 用用户响应解决一条 Permission 待审批;同时核对 Turn,防止陈旧卡片误答。 */
  respondPermission(
    promptId: string,
    response: TPermissionResponse,
    expectedTurnId?: string,
  ): boolean {
    const record = this.index.get(promptId);
    if (!record || record.entry.kind !== 'permission') return false;
    if (record.fifo.entries[0] !== record.entry) return false;
    if (expectedTurnId !== undefined && record.entry.turnId !== expectedTurnId) return false;
    return this.evict(promptId, response);
  }

  /** 用用户答案解决一条 AskUser 问询;promptId 未知或已解决时返回 false。 */
  respondAskUser(
    promptId: string,
    answers: Record<string, string>,
    expectedTurnId?: string,
  ): boolean {
    const record = this.index.get(promptId);
    if (!record || record.entry.kind !== 'askUser') return false;
    if (record.fifo.entries[0] !== record.entry) return false;
    if (expectedTurnId !== undefined && record.entry.turnId !== expectedTurnId) return false;
    return this.evict(promptId, { status: 'answered', answers });
  }

  /** 只允许 Permission 路由取消匹配 Turn 的活动 Permission 队首。 */
  cancelPermission(
    promptId: string,
    reason = 'cancelled',
    expectedTurnId?: string,
  ): boolean {
    return this.cancelActiveByKind(
      'permission',
      promptId,
      reason,
      expectedTurnId,
    );
  }

  /** 只允许 AskUser 路由取消匹配 Turn 的活动 AskUser 队首。 */
  cancelAskUser(
    promptId: string,
    reason = 'cancelled',
    expectedTurnId?: string,
  ): boolean {
    return this.cancelActiveByKind(
      'askUser',
      promptId,
      reason,
      expectedTurnId,
    );
  }

  /**
   * 用户只能取消类型和 Turn 均匹配的活动队首。Turn/Session 生命周期清理
   * 继续使用 cancel()/cancelForTurn()/cancelForSession()，不经过 HTTP 限制。
   */
  private cancelActiveByKind(
    kind: 'permission' | 'askUser',
    promptId: string,
    reason: string,
    expectedTurnId?: string,
  ): boolean {
    const record = this.index.get(promptId);
    if (!record || record.fifo.entries[0] !== record.entry) return false;
    if (record.entry.kind !== kind) return false;
    if (expectedTurnId !== undefined && record.entry.turnId !== expectedTurnId) return false;
    return this.cancel(promptId, reason);
  }

  /**
   * 不带真实响应地取消一条(用于 turn abort)。按 kind resolve:
   * permission→deny,askUser→cancelled。使 gate/askUser 干净退出。
   */
  cancel(promptId: string, reason = 'cancelled'): boolean {
    const record = this.index.get(promptId);
    if (!record) return false;
    // evict 内部按 entry.kind 分发 resolve;payload 类型由调用方保证与 kind 匹配。
    if (record.entry.kind === 'permission') {
      return this.evict(promptId, this.permissionCancellation(reason));
    }
    return this.evict(promptId, { status: 'cancelled', reason });
  }

  /** 取消某 Turn 的全部待交互(turn abort 时用)。 */
  cancelForTurn(turnId: string, reason = 'turn aborted'): number {
    const ids = [...this.index.values()]
      .filter(({ entry }) => entry.turnId === turnId)
      .map(({ entry }) => entry.promptId);
    let n = 0;
    for (const id of ids) {
      if (this.cancel(id, reason)) n++;
    }
    return n;
  }

  /** Session 删除时取消其全部待交互,避免悬挂 Promise。 */
  cancelForSession(sessionId: string, reason = 'session deleted'): number {
    const fifo = this.sessions.get(sessionId);
    if (!fifo) return 0;
    const ids = fifo.entries.map(e => e.promptId);
    for (const id of ids) {
      this.cancel(id, reason);
    }
    return ids.length;
  }

  /** 诊断:在飞条目总数。 */
  size(): number {
    return this.index.size;
  }

  /**
   * 返回可恢复的待交互快照(不暴露 Promise 与 timer)。
   * 传 sessionId 时只返回该 Session 的 FIFO(队首在前);不传时返回全部,按 createdAt 升序。
   */
  listPending(sessionId?: string): PendingInteraction<TPermissionPrompt, TAskRequest>[] {
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

  /** 把条目推入对应 Session FIFO;若队列为空,新条目立即成为队首并开始计时。 */
  private pushEntry(
    entry: SessionInteraction<TPermissionPrompt, TPermissionResponse, TAskRequest>,
  ): void {
    if (this.index.has(entry.promptId)) {
      throw new Error(`Duplicate interaction promptId: ${entry.promptId}`);
    }
    let fifo = this.sessions.get(entry.sessionId);
    if (!fifo) {
      fifo = { entries: [], timer: undefined };
      this.sessions.set(entry.sessionId, fifo);
    }
    const wasEmpty = fifo.entries.length === 0;
    fifo.entries.push(entry);
    this.index.set(entry.promptId, { fifo, entry });
    if (wasEmpty) {
      this.startHeadTimer(fifo);
    }
  }

  /**
   * 启动 fifo 队首的超时计时。调用前需保证 fifo.entries[0] 存在且旧 timer 已清。
   * 队首超时后以默认终态 resolve(permission→deny,askUser→timed_out),并让下一个
   * 条目升为队首继续计时。
   */
  private startHeadTimer(
    fifo: SessionFifo<TPermissionPrompt, TPermissionResponse, TAskRequest>,
  ): void {
    if (fifo.timer) clearTimeout(fifo.timer);
    const head = fifo.entries[0];
    if (!head) {
      fifo.timer = undefined;
      return;
    }
    fifo.timer = setTimeout(() => {
      const reason = `timed out after ${head.timeoutMs}ms`;
      // 超时按 kind resolve:permission→deny,askUser→明确超时终态。
      if (head.kind === 'permission') {
        this.evict(head.promptId, this.permissionCancellation(reason));
      } else {
        this.evict(head.promptId, { status: 'timed_out', reason });
      }
    }, head.timeoutMs);
  }

  /**
   * 把 promptId 对应条目移出 fifo 并 resolve。
   * 若移除的是队首,清理 timer 并让下一个升为队首开始计时;若队列空,移除 SessionFifo。
   */
  private evict(
    promptId: string,
    payload: TPermissionResponse | AskUserInteractionOutcome,
  ): boolean {
    const record = this.index.get(promptId);
    if (!record) return false;
    const { fifo, entry } = record;
    const wasHead = fifo.entries[0] === entry;

    if (wasHead && fifo.timer) {
      clearTimeout(fifo.timer);
      fifo.timer = undefined;
    }
    fifo.entries = fifo.entries.filter(e => e !== entry);
    this.index.delete(promptId);
    // 按 kind 分发 resolve;permission→PermissionResponse,askUser→answers。
    if (entry.kind === 'permission') {
      entry.resolve(payload as TPermissionResponse);
    } else {
      entry.resolve(payload as AskUserInteractionOutcome);
    }

    if (fifo.entries.length === 0) {
      this.sessions.delete(entry.sessionId);
    } else if (wasHead) {
      // 队首被移除,新的队首开始自己的超时。
      this.startHeadTimer(fifo);
    }
    return true;
  }
}

/** 把内部条目投影为可恢复快照,剥离 Promise 与 timer。 */
function toPending<TPermissionPrompt, TPermissionResponse, TAskRequest>(
  entry: SessionInteraction<TPermissionPrompt, TPermissionResponse, TAskRequest>,
): PendingInteraction<TPermissionPrompt, TAskRequest> {
  if (entry.kind === 'permission') {
    return {
      kind:      'permission',
      promptId:  entry.promptId,
      createdAt: entry.createdAt,
      prompt:    entry.prompt,
    };
  }
  return {
    kind:      'askUser',
    promptId:  entry.promptId,
    createdAt: entry.createdAt,
    request:   entry.request,
  };
}

/** 按业务 kind 过滤统一快照;路由层各自只关心自己负责的 Payload。 */
export function filterPermissionPending<TPermissionPrompt, TAskRequest>(
  pending: readonly PendingInteraction<TPermissionPrompt, TAskRequest>[],
): Array<{ promptId: string; createdAt: number; prompt: TPermissionPrompt }> {
  return pending
    .filter((p): p is Extract<
      PendingInteraction<TPermissionPrompt, TAskRequest>,
      { kind: 'permission' }
    > => p.kind === 'permission')
    .map(p => ({ promptId: p.promptId, createdAt: p.createdAt, prompt: p.prompt }));
}

/** 按业务 kind 过滤统一快照;AskUser 路由只恢复 askUser 问询。 */
export function filterAskUserPending<TPermissionPrompt, TAskRequest>(
  pending: readonly PendingInteraction<TPermissionPrompt, TAskRequest>[],
): Array<{ createdAt: number; request: TAskRequest }> {
  return pending
    .filter((p): p is Extract<
      PendingInteraction<TPermissionPrompt, TAskRequest>,
      { kind: 'askUser' }
    > => p.kind === 'askUser')
    .map(p => ({ createdAt: p.createdAt, request: p.request }));
}
