/**
 * SessionWriter 只负责 session 相关数据的持久化写入。
 *
 * 它负责：
 * - 创建 / 删除 Session。
 * - 写入 User Message。
 * - upsert Assistant Message 快照。
 * - 标记 Turn started / completed / failed / aborted。
 * - 更新 lastMode。
 * - 提供 fallback title 的纯函数。
 *
 * 它不负责：
 * - ActiveSession 内存态。
 * - Turn 并发锁。
 * - Prompt 组装。
 * - LLM 调用。
 * - Tool 执行。
 * - SSE 事件转换。
 */
import type { SqliteStorage } from "@ema-agent/storage-sql"

import type {
  ChatMessage,
  CreateSessionInput,
  EmaMode,
  EmaError,
  RequestId,
  SessionId,
  SessionState,
  SessionTitleStatus,
  TurnRecord,
  UsageView,
} from "@ema-agent/core-types"

export interface MarkTurnStartedInput {
  sessionId: SessionId
  requestId: RequestId
  mode: EmaMode
  startedAt: number
}

export interface AppendUserMessageInput {
  sessionId: SessionId
  requestId: RequestId
  message: ChatMessage
}

export interface UpsertAssistantMessageInput {
  sessionId: SessionId
  requestId: RequestId
  message: ChatMessage
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

export class SessionWriter {
  constructor(private readonly storage: SqliteStorage) {}

  async createSession(input: CreateSessionInput): Promise<SessionState> {
    // TODO:
    // 1. 调用 storage.sessions.create(...)
    // 2. 返回创建后的 SessionState
    const session = await this.storage.sessions.create(input)
    return session
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    // TODO:
    // 1. 调用 storage.sessions.delete(sessionId)
    // 2. 注意：具体级联删除由 storage-sql / SQLite 外键负责
    await this.storage.sessions.delete(sessionId)
  }

  async markTurnStarted(input: MarkTurnStartedInput): Promise<TurnRecord> {
    // 1. 创建 turns 记录，状态 running
    // 2. 更新 session.lastMode
    const turn = await this.storage.turns.createTurn({
        sessionId: input.sessionId,
        requestId: input.requestId,
        mode: input.mode,
        status: "running",
        startedAt: input.startedAt,
    })
    await this.storage.sessions.updateLastMode(input.sessionId, input.mode)
    return turn
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<void> {
    // 1. 将用户消息写入 storage
    await this.storage.messages.appendMessage(input.sessionId, input.message)
  }

  async upsertAssistantMessage(input: UpsertAssistantMessageInput): Promise<void> {
    // 流式更新：幂等覆盖，不会产生重复行
    await this.storage.messages.upsertMessage(input.sessionId, input.message)
  }

  async markTurnCompleted(input: MarkTurnCompletedInput): Promise<void> {
    // TODO:
    // 1. 更新 turn.status = completed
    // 2. 写入 endedAt
    // 3. 写入 usage
    const turn = await this.storage.turns.getTurnById(input.requestId)
    if (!turn) {
      throw new Error(`Turn with requestId ${input.requestId} not found`)
    }
    await this.storage.turns.updateTurn({
      requestId: input.requestId,
      status: "completed",
      usage: input.usage,
      endedAt: Date.now(),
    })

  }

  async markTurnFailed(input: MarkTurnFailedInput): Promise<void> {
    // TODO:
    // 1. 更新 turn.status = failed
    // 2. 写入 endedAt
    // 3. 写入 errorCode / errorMessage
    const turn = await this.storage.turns.getTurnById(input.requestId)
    if (!turn) {
      throw new Error(`Turn with requestId ${input.requestId} not found`)
    }
    await this.storage.turns.updateTurn({
      requestId: input.requestId,
      status: "failed",
      endedAt: Date.now(),
      errorCode: input.error.code,
      errorMessage: input.error.message
    })
  }

  async markTurnAborted(input: MarkTurnAbortedInput): Promise<void> {
    // TODO:
    // 1. 更新 turn.status = cancelled
    // 2. 写入 endedAt
    // 3. 写入 reason
    //
    // 这个函数主要服务于 abort-previous 策略：
    // 旧 turn 被内存中止后，数据库也必须同步为 cancelled。
    const turn = await this.storage.turns.getTurnById(input.requestId)
    if (!turn) {
      throw new Error(`Turn with requestId ${input.requestId} not found`)
    }
    await this.storage.turns.updateTurn({
      requestId: input.requestId,
      status: "cancelled",
      endedAt: Date.now(),
    })
  }

  async updateTitle(
    sessionId: SessionId,
    title: string,
    status: SessionTitleStatus = "manual",
  ): Promise<void> {
    await this.storage.sessions.updateTitle(sessionId, title, status)
  }
}

/**
 * 生成 fallback 标题。
 *
 * 这是纯函数，不访问数据库，不调用 LLM。
 */
export function createFallbackTitle(userText: string, maxLength = 24): string {
    const cleaned = userText.trim().replace(/\s+/g, " ")
    if (cleaned === "") {
        return "新对话"
    }
    if (cleaned.length <= maxLength) {
        return cleaned
    }
    return `${cleaned.substring(0, maxLength)}...`
}
/**
 * 判断当前 session 是否适合写入 fallback title。
 *
 * 这是纯函数，不访问数据库。
 */
export function shouldUseFallbackTitle(session: SessionState): boolean {
  // TODO:
  // 1. titleStatus 是 default / failed 时可以 fallback
  // 2. manual / generated 不应该覆盖
  return session.titleStatus === "default" || session.titleStatus === "failed"
}
