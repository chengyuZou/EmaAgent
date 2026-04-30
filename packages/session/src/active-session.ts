/**
 * ActiveSession 只管理“单个已激活 Session”的进程内状态。
 *
 * 它负责：
 * - 记录当前正在运行的 Turn。
 * - 保存当前 Turn 的 AbortController，用于用户中断生成。
 * - 维护本 Session 的订阅者列表，并向订阅者发布内部状态变化。
 *
 * 它不负责：
 * - 创建 / 删除 Session。
 * - 从数据库读取历史消息。
 * - 把 Turn 状态写入数据库。
 * - 组装 Prompt。
 * - 调用 LLM。
 * - 执行 Tool。
 * - 决定 Session 何时被清理。
 *
 * 清理策略由 SessionManager 负责。
 * 持久化由 SessionWriter 负责。
 * 编排执行由 Orchestrator 负责。
 */

import type {
  SessionId,
  RequestId,
  EmaMode,
  TurnStatus,
  UnixMs,
  EmaError,
} from "@ema-agent/core-types"

/**
 * 内存中的 Turn 对象。
 *
 * 注意：
 * - 这是进程内状态，不进入 core-types。
 * - AbortController 不可 JSON 序列化，不能落盘，不能传前端。
 */
export interface ActiveTurn {
  requestId: RequestId
  sessionId: SessionId
  mode: EmaMode
  startedAt: UnixMs
  status: TurnStatus
  error?: EmaError
  abortController: AbortController
}

/**
 * ActiveSession 内部生命周期事件。
 *
 * 这些事件只供 session / orchestrator 内部协作使用，
 * 不是推送给前端的 SSE 事件。
 */
export type SessionLifecycleEvent =
  | { type: "turn:started"; sessionId: SessionId; requestId: RequestId }
  | { type: "turn:completed"; sessionId: SessionId; requestId: RequestId }
  | { type: "turn:failed"; sessionId: SessionId; requestId: RequestId; error: EmaError }
  | { type: "turn:aborted"; sessionId: SessionId; requestId: RequestId; reason?: string }

export type UnsubscribeFn = () => void
export type SessionEventCallback = (event: SessionLifecycleEvent) => void

export class ActiveSession {
  private currentTurn: ActiveTurn | null = null
  private readonly subscribers = new Set<SessionEventCallback>()

  constructor(public readonly sessionId: SessionId) {}

  getCurrentTurn(): ActiveTurn | null {
    return this.currentTurn
  }

  isIdle(): boolean {
    return this.currentTurn === null && this.subscribers.size === 0
  }

  beginTurnInMemory(requestId: RequestId, mode: EmaMode): ActiveTurn {
    if (this.currentTurn !== null) {
      throw new Error("Active turn already exists in this session.")
    }

    const turn: ActiveTurn = {
      requestId,
      sessionId: this.sessionId,
      mode,
      startedAt: Date.now(),
      status: "running",
      abortController: new AbortController(),
    }

    this.currentTurn = turn

    this.publish({
      type: "turn:started",
      sessionId: this.sessionId,
      requestId,
    })

    return turn
  }

  completeTurnInMemory(requestId: RequestId): void {
    if (this.currentTurn?.requestId !== requestId) {
      return
    }

    this.currentTurn.status = "completed"

    this.publish({
      type: "turn:completed",
      sessionId: this.sessionId,
      requestId,
    })

    this.currentTurn = null
  }

  failTurnInMemory(requestId: RequestId, error: EmaError): void {
    if (this.currentTurn?.requestId !== requestId) {
      return
    }

    this.currentTurn.status = "failed"
    this.currentTurn.error = error

    this.publish({
      type: "turn:failed",
      sessionId: this.sessionId,
      requestId,
      error,
    })

    this.currentTurn = null
  }

  abortCurrentTurn(reason?: string): void {
    if (this.currentTurn === null) {
      return
    }

    const { requestId, abortController } = this.currentTurn

    abortController.abort(reason)
    this.currentTurn.status = "cancelled"

    this.publish({
      type: "turn:aborted",
      sessionId: this.sessionId,
      requestId,
      reason,
    })

    this.currentTurn = null
  }

  subscribe(callback: SessionEventCallback): UnsubscribeFn {
    this.subscribers.add(callback)

    return () => {
      this.subscribers.delete(callback)
    }
  }

  publish(event: SessionLifecycleEvent): void {
    for (const callback of this.subscribers) {
      try {
        callback(event)
      } catch {
        // 第一版先吞掉订阅者错误。
        // 后续可以接 logger，避免一个坏 listener 影响其他 listener。
      }
    }
  }
}