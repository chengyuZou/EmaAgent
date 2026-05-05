/**
 * SessionWriter 只负责 session 相关数据的持久化写入。
 *
 * 它负责：
 * - 创建 / 删除 Session。
 * - 写入 User Message / Assistant Message Shell / upsert Assistant Message。
 * - 标记 Turn queued → running → completed / failed / aborted。
 * - 更新 lastMode 和 title。
 *
 * 它不负责：
 * - ActiveSession 内存态。
 * - Turn 并发锁。
 * - Prompt 组装 / LLM 调用 / Tool 执行 / SSE 事件转换。
 */
import { SESSION_TITLE_MAX_LENGTH, TITLE_TRUNCATION_SUFFIX } from "@ema-agent/constants-core"
import type { SqliteStorage } from "@ema-agent/storage-sql"

import { EmaError } from "@ema-agent/core-types"
import type {
  ChatMessage,
  CreateSessionInput,
  EmaMode,
  RequestId,
  SessionId,
  SessionState,
  SessionTitleStatus,
  TurnRecord,
  UsageView,
} from "@ema-agent/core-types"

// ═══════════════════════════════════════════════════════════════
// 输入类型
// ═══════════════════════════════════════════════════════════════

export interface MarkTurnInput {
  sessionId: SessionId
  requestId: RequestId
  mode: EmaMode
  startedAt: number
}

export interface MarkTurnCompletedInput {
  sessionId: SessionId
  requestId: RequestId
  usage?: UsageView
}

export interface MarkTurnFailedInput {
  sessionId: SessionId
  requestId: RequestId
  error: EmaError
}

export interface MarkTurnAbortedInput {
  sessionId: SessionId
  requestId: RequestId
  reason?: string
}

// ═══════════════════════════════════════════════════════════════
// SessionWriter
// ═══════════════════════════════════════════════════════════════

export class SessionWriter {
  constructor(private readonly storage: SqliteStorage) {}

  // ---- Session CRUD ----

  async createSession(input: CreateSessionInput): Promise<SessionState> {
    return await this.storage.sessions.create(input)
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    await this.storage.sessions.delete(sessionId)
  }

  async getSession(sessionId: SessionId): Promise<SessionState | null> {
    return await this.storage.sessions.getById(sessionId)
  }

  // ---- Turn 状态标记 ----

  async markTurnQueued(input: MarkTurnInput): Promise<TurnRecord> {
    const turn = await this.storage.turns.createTurn({
      requestId: input.requestId,
      sessionId: input.sessionId,
      mode: input.mode,
      status: "queued",
      startedAt: input.startedAt,
    })
    await this.storage.sessions.updateLastMode(input.sessionId, input.mode)
    return turn
  }

  async markTurnRunning(_sessionId: SessionId, requestId: RequestId): Promise<void> {
    await this.storage.turns.updateTurn({ requestId, status: "running" })
  }

  async markTurnCompleted(input: MarkTurnCompletedInput): Promise<void> {
    const turn = await this.storage.turns.getTurnById(input.requestId)
    if (!turn) {
      throw new EmaError("turn_not_found", `Turn ${input.requestId} not found`, false)
    }
    await this.storage.turns.updateTurn({
      requestId: input.requestId,
      status: "completed",
      usage: input.usage,
      endedAt: Date.now(),
    })
  }

  async markTurnFailed(input: MarkTurnFailedInput): Promise<void> {
    const turn = await this.storage.turns.getTurnById(input.requestId)
    if (!turn) {
      throw new EmaError("turn_not_found", `Turn ${input.requestId} not found`, false)
    }
    await this.storage.turns.updateTurn({
      requestId: input.requestId,
      status: "failed",
      endedAt: Date.now(),
      errorCode: input.error.code,
      errorMessage: input.error.message,
    })
  }

  async markTurnAborted(input: MarkTurnAbortedInput): Promise<void> {
    const turn = await this.storage.turns.getTurnById(input.requestId)
    if (!turn) {
      throw new EmaError("turn_not_found", `Turn ${input.requestId} not found`, false)
    }
    await this.storage.turns.updateTurn({
      requestId: input.requestId,
      status: "cancelled",
      endedAt: Date.now(),
    })
  }

  // ---- 消息写入 ----

  async appendUserMessage(sessionId: SessionId, message: ChatMessage): Promise<void> {
    await this.storage.messages.appendMessage(sessionId, message)
  }

  async appendAssistantMessageShell(sessionId: SessionId, message: ChatMessage): Promise<void> {
    await this.storage.messages.appendMessage(sessionId, message)
  }

  async upsertAssistantMessage(sessionId: SessionId, message: ChatMessage): Promise<void> {
    await this.storage.messages.upsertMessage(sessionId, message)
  }

  // ---- 标题 ----

  async updateTitle(
    sessionId: SessionId,
    title: string,
    status: SessionTitleStatus = "manual",
  ): Promise<void> {
    await this.storage.sessions.updateTitle(sessionId, title, status)
  }
}

// ═══════════════════════════════════════════════════════════════
// 纯函数（不访问 DB）
// ═══════════════════════════════════════════════════════════════

export function createFallbackTitle(userText: string, maxLength = SESSION_TITLE_MAX_LENGTH): string {
  const cleaned = userText.trim().replace(/\s+/g, " ")
  if (cleaned === "") {
    return "新对话"
  }
  if (cleaned.length <= maxLength) {
    return cleaned
  }
  return `${cleaned.substring(0, maxLength)}${TITLE_TRUNCATION_SUFFIX}`
}

export function shouldUseFallbackTitle(session: SessionState): boolean {
  return session.titleStatus === "default" || session.titleStatus === "failed"
}
