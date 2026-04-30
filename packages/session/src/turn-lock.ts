/**
 * 负责 Session 级别的并发 Turn 控制。
 *
 * 同一个 Session 在同一时刻通常只能有一个正在运行的 Turn。
 * 当新的请求到达时，系统需要决定如何处理冲突。
 */

import type { RequestId } from "@ema-agent/core-types"
import type { ActiveSession } from "./active-session.js"

export type TurnLockStrategy = "reject" | "abort-previous"

export interface TurnLockResult {
  /** 是否允许新的 Turn 开始 */
  allowed: boolean

  /** 如果不允许，拒绝的原因 */
  reason?: "turn_in_progress"

  /** 如果策略是 abort-previous，这里记录被强制打断的旧请求 ID */
  abortedRequestId?: RequestId
}

/**
 * 尝试为新的请求获取 Turn 执行锁。
 *
 * V1 不实现 queue。原因是 queue 需要处理上下文过期、附件状态、用户取消、
 * 权限弹窗等额外状态，容易让 session 层变复杂。
 *
 * @param activeSession 内存中的活跃会话
 * @param newRequestId 新的请求 ID
 * @param strategy 冲突解决策略，默认打断上一个正在运行的 Turn
 */
export function acquireTurnLock(
  activeSession: ActiveSession,
  newRequestId: RequestId,
  strategy: TurnLockStrategy = "abort-previous",
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

    case "abort-previous": {
      const abortedRequestId = currentTurn.requestId
      activeSession.abortCurrentTurn("superseded_by_new_turn")

      return {
        allowed: true,
        abortedRequestId,
      }
    }
  }
}