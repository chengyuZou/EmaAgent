/**
 * Session 级别的 Turn 并发控制——纯函数，不修改任何状态。
 *
 * 同一个 Session 同时最多一个正在运行的 Turn。
 * 调用方负责在持久化成功后执行内存态 abort，避免 DB 与内存不一致。
 *
 * V1 不实现 queue——queue 需要处理上下文过期、附件状态、
 * 用户取消、权限弹窗等额外复杂度。
 */

import type { RequestId } from "@ema-agent/core-types"
import type { ActiveSession } from "./active-session.js"

export type TurnLockStrategy = "reject" | "abort-previous"

export interface TurnLockResult {
  /** 是否允许新的 Turn 开始。 */
  allowed: boolean
  /** 拒绝原因（仅 allowed = false 时有效）。 */
  reason?: "turn_in_progress"
  /** 被强制打断的旧 Turn 的 requestId（仅 strategy = "abort-previous" 且存在旧 Turn 时有效）。 */
  abortedRequestId?: RequestId
}

/**
 * 尝试为新的请求获取 Turn 执行锁。
 *
 * 此函数只做决策，不修改 ActiveSession。
 * 调用方负责：
 * 1. 先落盘旧 Turn 的 abort 状态（如需要）
 * 2. 再调用 activeSession.abortCurrentTurn()
 * 3. 最后开始新 Turn
 */
export function acquireTurnLock(
  activeSession: ActiveSession,
  newRequestId: RequestId,
  strategy: TurnLockStrategy,
): TurnLockResult {
  const currentTurn = activeSession.getCurrentTurn()

  if (!currentTurn) {
    return { allowed: true }
  }

  if (currentTurn.requestId === newRequestId) {
    return { allowed: false, reason: "turn_in_progress" }
  }

  switch (strategy) {
    case "reject":
      return { allowed: false, reason: "turn_in_progress" }

    case "abort-previous":
      return { allowed: true, abortedRequestId: currentTurn.requestId }
  }
}
