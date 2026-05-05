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
import { randomUUID } from "node:crypto"

import { EmaError } from "@ema-agent/core-types"
import type {
  ChatMessage,
  EmaMode,
  MessageContentBlock,
  MessageId,
  RequestId,
  SessionId,
  TurnInputBlock,
  TurnRecord,
  UsageView,
} from "@ema-agent/core-types"
import type { SqliteStorage } from "@ema-agent/storage-sql"

import { ActiveSession } from "./active-session.js"
import { acquireTurnLock, type TurnLockStrategy } from "./turn-lock.js"
import { SessionWriter } from "./session-writer.js"

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

export interface EnsureSessionResult {
  created: boolean
}

export interface BeginTurnInput {
  sessionId: SessionId
  requestId: RequestId
  mode: EmaMode
  /** 用户原始输入块——SessionManager 内部构建 ChatMessage。 */
  userInputBlocks: TurnInputBlock[]
  lockStrategy?: TurnLockStrategy
}

export interface BeginTurnResult {
  turn: TurnRecord
  abortSignal: AbortSignal
  userMessageId: MessageId
  assistantMessageId: MessageId
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

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

function createMessageId(): MessageId {
  return `msg_${randomUUID()}` as MessageId
}

function userInputBlocksToContentBlocks(input: TurnInputBlock[]): MessageContentBlock[] {
  return input.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text }
      case "image_ref":
      case "file_ref":
        return { type: "attachment_ref", attachmentId: block.attachmentId }
      case "artifact_ref":
        return { type: "artifact_ref", artifact: { id: block.artifactId } } as MessageContentBlock
    }
  })
}

// ═══════════════════════════════════════════════════════════════
// SessionManager
// ═══════════════════════════════════════════════════════════════

export class SessionManager {
  private readonly activeSessions = new Map<SessionId, ActiveSession>()
  private readonly writer: SessionWriter

  constructor(storage: SqliteStorage) {
    this.writer = new SessionWriter(storage)
  }

  async ensureSession(
    sessionId: SessionId,
    opts?: { title?: string; mode?: EmaMode },
  ): Promise<EnsureSessionResult> {
    const existing = await this.writer.getSession(sessionId)
    if (existing) {
      return { created: false }
    }

    await this.writer.createSession({
      id: sessionId,
      title: opts?.title ?? "New Chat",
      lastMode: opts?.mode ?? "chat",
    })

    return { created: true }
  }

  getOrCreateActiveSession(sessionId: SessionId): ActiveSession {
    const existing = this.activeSessions.get(sessionId)
    if (existing) return existing

    const activeSession = new ActiveSession(sessionId)
    this.activeSessions.set(sessionId, activeSession)
    return activeSession
  }

  async beginTurn(input: BeginTurnInput): Promise<BeginTurnResult> {
    const strategy = input.lockStrategy ?? "abort-previous"

    // 1. 获取或创建内存态
    const activeSession = this.getOrCreateActiveSession(input.sessionId)

    // 2. 获取并发锁
    const lockResult = acquireTurnLock(activeSession, input.requestId, strategy)
    if (!lockResult.allowed) {
      throw new EmaError("turn_in_progress", "当前已有一个请求正在处理，请稍后再试", true)
    }

    // 3. 如果策略是 abort-previous 且有旧 Turn，先落盘旧 Turn 的 abort 再标记内存
    if (lockResult.abortedRequestId) {
      await this.writer.markTurnAborted({
        sessionId: input.sessionId,
        requestId: lockResult.abortedRequestId,
        reason: "superseded_by_new_turn",
      })
      activeSession.abortCurrentTurn("superseded_by_new_turn")
    }

    // 4. 内存注册新 Turn
    const activeTurn = activeSession.beginTurnInMemory(input.requestId, input.mode)

    try {
      // 5. 落盘 queued
      const turn = await this.writer.markTurnQueued({
        sessionId: input.sessionId,
        requestId: input.requestId,
        mode: input.mode,
        startedAt: activeTurn.startedAt,
      })

      // 6. 构建并写用户消息
      const userMessageId = createMessageId()
      const userMessage: ChatMessage = {
        id: userMessageId,
        role: "user",
        contentBlocks: userInputBlocksToContentBlocks(input.userInputBlocks),
        requestId: input.requestId,
        status: "complete",
        createdAt: Date.now(),
      }
      await this.writer.appendUserMessage(input.sessionId, userMessage)

      // 7. 构建并写 assistant 空壳
      const assistantMessageId = createMessageId()
      const assistantShell: ChatMessage = {
        id: assistantMessageId,
        role: "assistant",
        contentBlocks: [],
        requestId: input.requestId,
        status: "generating",
        createdAt: Date.now(),
      }
      await this.writer.appendAssistantMessageShell(input.sessionId, assistantShell)

      // 8. 推进到 running
      await this.writer.markTurnRunning(input.sessionId, input.requestId)

      return {
        turn: { ...turn, status: "running" },
        abortSignal: activeTurn.abortController.signal,
        userMessageId,
        assistantMessageId,
      }
    } catch (error) {
      // DB 写失败 → 尽力标 failed + 回滚内存态
      const emaError =
        error instanceof EmaError
          ? error
          : error instanceof Error
            ? new EmaError("internal_error", error.message, false)
            : new EmaError("unknown_error", "发生未知错误", false)

      try {
        await this.writer.markTurnFailed({
          sessionId: input.sessionId,
          requestId: input.requestId,
          error: emaError,
        })
      } catch {
        // markTurnQueued 可能在建行前就失败了，turn 行不存在
      }

      activeSession.failTurnInMemory(input.requestId, emaError)
      throw emaError
    }
  }

  async completeTurn(input: CompleteTurnInput): Promise<void> {
    await this.writer.markTurnCompleted(input)
    const activeSession = this.activeSessions.get(input.sessionId)
    if (activeSession) {
      activeSession.completeTurnInMemory(input.requestId)
    }
  }

  async failTurn(input: FailTurnInput): Promise<void> {
    await this.writer.markTurnFailed(input)
    const activeSession = this.activeSessions.get(input.sessionId)
    if (activeSession) {
      activeSession.failTurnInMemory(input.requestId, input.error)
    }
  }

  abortTurn(sessionId: SessionId): void {
    const activeSession = this.activeSessions.get(sessionId)
    if (activeSession) {
      activeSession.abortCurrentTurn("aborted_by_user")
    }
  }

  unloadSession(sessionId: SessionId): void {
    const activeSession = this.activeSessions.get(sessionId)
    if (activeSession && activeSession.isIdle()) {
      this.activeSessions.delete(sessionId)
    }
  }
}
