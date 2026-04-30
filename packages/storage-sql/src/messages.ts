/**
 * SQLite Message Repository.
 *
 * 只负责 messages 表的读写。
 *
 * 它负责：
 * - 插入 user/tool/system message。
 * - upsert assistant message 快照。
 * - 按 session 分页读取历史消息。
 * - 按 requestId 读取某个 turn 产生的消息。
 *
 * 它不负责：
 * - 创建 / 删除 session。
 * - 创建 / 更新 turn。
 * - 组装 prompt。
 * - 处理 LLM stream。
 * - 处理 artifact payload。
 */

import type { Database } from "better-sqlite3"
import type {
  ChatMessage,
  ListMessagesOptions,
  MessageId,
  MessagePage,
  RequestId,
  SessionId,
  MessageRole,
} from "@ema-agent/core-types"

export interface MessageRepository {
  getById(messageId: MessageId): Promise<ChatMessage | null>

  appendMessage(
    sessionId: SessionId,
    message: ChatMessage,
  ): Promise<void>

  upsertMessage(
    sessionId: SessionId,
    message: ChatMessage,
  ): Promise<void>

  listMessagesBySession(
    sessionId: SessionId,
    options?: ListMessagesOptions,
  ): Promise<MessagePage>

  listMessagesByRequest(
    requestId: RequestId,
  ): Promise<ChatMessage[]>

  deleteMessagesBySession(
    sessionId: SessionId,
  ): Promise<void>
}

// ==========================================
// Row → Entity 映射
// ==========================================

function rowToChatMessage(row: any): ChatMessage {
  return {
    id: row.id,
    role: row.role as MessageRole,
    requestId: row.request_id ?? undefined,
    status: row.status,
    errorCode: row.error_code ?? undefined,
    contentBlocks: JSON.parse(row.content_blocks || "[]"),
    createdAt: row.created_at,
  }
}

// ==========================================
// 工厂函数
// ==========================================

export function createMessageRepository(db: Database): MessageRepository {
  return {
    async getById(messageId) {
      // TODO: SELECT * FROM messages WHERE id = ?
      const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId)
      return row ? rowToChatMessage(row) : null
    },

    async appendMessage(sessionId, message) {
      // TODO:
      // 1. INSERT INTO messages
      // 2. content_blocks 用 JSON.stringify
      // 3. 更新 sessions.updated_at 可以放到 SessionWriter 或 storage 事务里决定
      const contentBlocksStr = JSON.stringify(message.contentBlocks)
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content_blocks, request_id, status, error_code, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        sessionId,
        message.role,
        contentBlocksStr,
        message.requestId ?? null,
        message.status,
        message.errorCode ?? null,
        message.createdAt,
      )
    },

    async upsertMessage(sessionId, message) {
      // TODO:
      // 1. INSERT INTO messages
      // 2. ON CONFLICT(id) DO UPDATE
      // 3. 用于 assistant 流式快照
        const contentBlocksStr = JSON.stringify(message.contentBlocks)
        db.prepare(`
        INSERT INTO messages (id, session_id, role, content_blocks, request_id, status, error_code, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            content_blocks = excluded.content_blocks,
            status = excluded.status,
            error_code = excluded.error_code
      `).run(
        message.id,
        sessionId,
        message.role,
        contentBlocksStr,
        message.requestId ?? null,
        message.status,
        message.errorCode ?? null,
        message.createdAt,
      )
    },

    async listMessagesBySession(sessionId, options = {}) {
      // TODO:
      // 1. WHERE session_id = ?
      // 2. 支持 beforeMessageId / limit
      // 3. limit + 1 判断 hasMore
      const limit = options.limit ?? 50

      let sql = `
        SELECT *
        FROM messages
        WHERE session_id = ?
      `

      const params: unknown[] = [sessionId]

      if (options.beforeMessageId) {
        const cursorRow = db
          .prepare(`SELECT created_at FROM messages WHERE id = ?`)
          .get(options.beforeMessageId) as { created_at: number } | undefined

        if (cursorRow) {
          sql += ` AND created_at < ?`
          params.push(cursorRow.created_at)
        }
      }

      sql += `
        ORDER BY created_at DESC
        LIMIT ?
      `

      params.push(limit + 1)

      const rows = db.prepare(sql).all(...params)
      const hasMore = rows.length > limit
      const pageRows = hasMore ? rows.slice(0, limit) : rows

      const messages = pageRows
        .map(rowToChatMessage)
        .reverse()

      return {
        items: messages,
        hasMore,
        nextBeforeMessageId: hasMore ? messages[0]?.id : undefined,
      }
    },

    async listMessagesByRequest(requestId) {
      // TODO:
      // 1. WHERE request_id = ?
      // 2. ORDER BY created_at ASC
        const rows = db.prepare(`SELECT * FROM messages WHERE request_id = ? ORDER BY created_at ASC`).all(requestId)
        return rows.map(rowToChatMessage)
    },

    async deleteMessagesBySession(sessionId) {
      // TODO:
      // 通常不需要手动调用，因为删除 session 时 SQLite 外键 cascade 会处理。
      // 但保留这个方法方便测试或维护。
        db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId)
    },
  }
}
