/**
 * SessionReader 只负责 session 相关数据的只读查询。
 *
 * 它负责：
 * - 读取左侧会话列表。
 * - 打开一个 session 的详情。
 * - 分页读取历史消息 / turn。
 * - 读取 session 下的 artifact 摘要。
 *
 * 它不负责：
 * - 创建 / 删除 Session。
 * - 写入 Message。
 * - 修改 Turn 状态。
 * - 调用 LLM。
 * - 组装 Prompt。
 */
import { RECENT_MESSAGES_PAGE_SIZE } from "@ema-agent/constants-core"
import type { SqliteStorage } from "@ema-agent/storage-sql"

import type {
  MessagePage,
  SessionDetailView,
  SessionId,
  SessionSummary,
  MessageId,
  RequestId,
} from "@ema-agent/core-types"


export interface LoadSessionHistoryInput {
  sessionId: SessionId
  limit?: number
  beforeMessageId?: MessageId
}

export class SessionReader {
  constructor(private readonly storage: SqliteStorage) {}

  async listSessions(): Promise<SessionSummary[]> {
    return this.storage.sessions.list()
  }

  async loadSessionDetail(sessionId: SessionId): Promise<SessionDetailView | null> {
    const sessionState = await this.storage.sessions.getById(sessionId)
    if (!sessionState) {
      return null
    }

    const [recentMessages, recentTurns, artifacts] = await Promise.all([
      this.storage.messages.listMessagesBySession(sessionId, { limit: RECENT_MESSAGES_PAGE_SIZE }),
      this.storage.turns.listTurnsBySession(sessionId, { limit: 1 }),
      this.storage.artifacts.listArtifactsBySession(sessionId),
    ])

    const lastRequestId = recentTurns.items[0]?.requestId as RequestId | undefined

    return {
      session: sessionState,
      initialMessages: recentMessages,
      lastRequestId,
      artifacts,
    }
  }

  async loadSessionHistory(input: LoadSessionHistoryInput): Promise<MessagePage> {
    return this.storage.messages.listMessagesBySession(input.sessionId, {
      limit: input.limit,
      beforeMessageId: input.beforeMessageId,
    })
  }
}