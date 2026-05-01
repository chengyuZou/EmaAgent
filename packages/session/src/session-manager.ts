/**
 * SessionManager 是 @ema-agent/session 的对外组合入口。
 *
 * 它组合：
 * - ActiveSession 的内存态。
 * - TurnLock 的并发控制。
 * - SessionWriter 的持久化写入。
 *
 * 它不负责：
 * - Prompt assembly。
 * - LLM stream。
 * - Tool 执行。
 * - SSE transport。
 */
import { EmaError } from "@ema-agent/core-types"
import type { SqliteStorage } from "@ema-agent/storage-sql"

import type {
  ChatMessage,
  EmaMode,
  RequestId,
  SessionId,
  TurnRecord,
  UsageView,
} from "@ema-agent/core-types"

import { ActiveSession } from "./active-session.js"
import { acquireTurnLock, type TurnLockStrategy } from "./turn-lock.js"
import { SessionWriter } from "./session-writer.js"

function toEmaError(error: unknown): EmaError {
  if (error instanceof EmaError) {
    return error
  }

  if (error instanceof Error) {
    return new EmaError("internal_error", error.message, false, {
      name: error.name,
      stack: error.stack,
    })
  }

  return new EmaError("unknown_error", "发生未知错误", false, { originalError: error })
}

export interface BeginTurnInput {
  sessionId: SessionId
  requestId: RequestId
  mode: EmaMode
  userMessage: ChatMessage
  lockStrategy?: TurnLockStrategy
}

export interface BeginTurnResult {
  turn: TurnRecord
  abortSignal: AbortSignal
}

export interface CompleteTurnInput {
  sessionId: SessionId
  requestId: RequestId
  usage?: UsageView
}

export interface FailTurnInput {
  sessionId: SessionId
  requestId: RequestId
  error: EmaError
}

export class SessionManager {
  private readonly activeSessions = new Map<SessionId, ActiveSession>()
  private readonly writer: SessionWriter

  constructor(storage: SqliteStorage) {
    this.writer = new SessionWriter(storage)
  }

  getOrCreateActiveSession(sessionId: SessionId): ActiveSession {
    // TODO:
    // 1. 如果 activeSessions 已有，直接返回
    // 2. 否则 new ActiveSession(sessionId) 并放入 Map
    if (this.activeSessions.has(sessionId)) {
      return this.activeSessions.get(sessionId)!
    }
    const activeSession = new ActiveSession(sessionId)
    this.activeSessions.set(sessionId, activeSession)
    return activeSession
  }

  async beginTurn(input: BeginTurnInput): Promise<BeginTurnResult> {
    // TODO:
    // 1. getOrCreateActiveSession
    // 2. acquireTurnLock
    // 3. 如果 abort-previous 发生，markTurnAborted 旧 turn
    // 4. beginTurnInMemory
    // 5. markTurnStarted
    // 6. appendUserMessage
    // 7. 如果 DB 写失败，failTurnInMemory 并向上抛错
    // 8. 返回 turn + abortSignal
    const activeSession = this.getOrCreateActiveSession(input.sessionId)
    const { allowed, reason  , abortedRequestId } = acquireTurnLock(activeSession, input.requestId, input.lockStrategy || "reject")
    if (!allowed) {
      if (reason === "turn_in_progress") {
        throw new EmaError("turn_in_progress", "当前已有一个请求正在处理，请稍后再试", true)
      }
    }
    if (abortedRequestId) {
      await this.writer.markTurnAborted({
        sessionId: input.sessionId,
        requestId: abortedRequestId,
        reason: "superseded_by_new_turn",
      })
      activeSession.abortCurrentTurn("superseded_by_new_turn")
    }
    const turn = activeSession.beginTurnInMemory(input.requestId, input.mode)
    try {
      await this.writer.markTurnStarted({
        sessionId: input.sessionId,
        requestId: input.requestId,
        mode: input.mode,
        startedAt: turn.startedAt,
      })
      await this.writer.appendUserMessage({
        sessionId: input.sessionId,
        requestId: input.requestId,
        message: input.userMessage,
      })
    } catch (error) {
      const emaError = toEmaError(error)
      try {
        await this.writer.markTurnFailed({
          sessionId: input.sessionId,
          requestId: input.requestId,
          error: emaError,
        })
      } catch {
        // Preserve the original beginTurn failure. markTurnStarted may have failed
        // before the DB row existed, or storage may still be unavailable.
      }
      activeSession.failTurnInMemory(input.requestId, emaError)
      throw error
    }
    return {
      turn: {
        requestId: input.requestId,
        sessionId: input.sessionId,
        mode: input.mode,
        status: "running",
        startedAt: turn.startedAt,
      },
      abortSignal: turn.abortController.signal,
    }
  }

  async completeTurn(input: CompleteTurnInput): Promise<void> {
    // TODO:
    // 1. 先写 DB completed
    // 2. 再 completeTurnInMemory
    await this.writer.markTurnCompleted(input)
    const activeSession = this.activeSessions.get(input.sessionId)
    if (activeSession) {
      activeSession.completeTurnInMemory(input.requestId)
    }
  }

  async failTurn(input: FailTurnInput): Promise<void> {
    // TODO:
    // 1. 先写 DB failed
    // 2. 再 failTurnInMemory
    await this.writer.markTurnFailed(input)
    const activeSession = this.activeSessions.get(input.sessionId)
    if (activeSession) {
      activeSession.failTurnInMemory(input.requestId, input.error)
    }
  }

  abortTurn(sessionId: SessionId): void {
    // TODO:
    // 1. 找到 ActiveSession
    // 2. 调用 abortCurrentTurn
    // 注意：这里只中断内存态。
    // DB 的 cancelled 标记最好由 orchestrator catch abort 后调用 fail/abort 写入。
    const activeSession = this.activeSessions.get(sessionId)
    if (activeSession) {
      activeSession.abortCurrentTurn("aborted_by_user")
    }
  }

  unloadSession(sessionId: SessionId): void {
    // TODO:
    // 1. 如果当前 session 没有 running turn，才能 unload
    // 2. 从 activeSessions 删除
    const activeSession = this.activeSessions.get(sessionId)
    if (activeSession && activeSession.isIdle()) {
      this.activeSessions.delete(sessionId)
    }
  }
}
