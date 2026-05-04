/**
 * Message 仓储 — messages 表 CRUD。
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
  MessageStatus,
} from "@ema-agent/core-types"
import { RECENT_MESSAGES_PAGE_SIZE } from "@ema-agent/constants-core"

export interface MessageRepository {
  getById(messageId: MessageId): Promise<ChatMessage | null>
  appendMessage(sessionId: SessionId, message: ChatMessage): Promise<void>
  upsertMessage(sessionId: SessionId, message: ChatMessage): Promise<void>
  listMessagesBySession(sessionId: SessionId, options?: ListMessagesOptions): Promise<MessagePage>
  listMessagesByRequest(requestId: RequestId): Promise<ChatMessage[]>
  deleteMessagesBySession(sessionId: SessionId): Promise<void>
}

interface MessageRow {
  id: string
  session_id: string
  role: string
  content_blocks: string
  request_id: string | null
  status: string
  error_code: string | null
  created_at: number
}

function rowToChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id as MessageId,
    role: row.role as MessageRole,
    requestId: row.request_id as RequestId | undefined,
    status: row.status as MessageStatus,
    errorCode: row.error_code ?? undefined,
    contentBlocks: JSON.parse(row.content_blocks || "[]"),
    createdAt: row.created_at,
  }
}

function touchSession(db: Database, sessionId: SessionId): void {
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), sessionId)
}

export function createMessageRepository(db: Database): MessageRepository {
  return {
    async getById(messageId) {
      const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined
      return row ? rowToChatMessage(row) : null
    },

    async appendMessage(sessionId, message) {
      const write = db.transaction(() => {
        db.prepare(`
          INSERT INTO messages (id, session_id, role, content_blocks, request_id, status, error_code, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          message.id,
          sessionId,
          message.role,
          JSON.stringify(message.contentBlocks),
          message.requestId ?? null,
          message.status,
          message.errorCode ?? null,
          message.createdAt,
        )
        touchSession(db, sessionId)
      })
      write()
    },

    async upsertMessage(sessionId, message) {
      const write = db.transaction(() => {
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
          JSON.stringify(message.contentBlocks),
          message.requestId ?? null,
          message.status,
          message.errorCode ?? null,
          message.createdAt,
        )
        touchSession(db, sessionId)
      })
      write()
    },

    async listMessagesBySession(sessionId, options = {}) {
      const limit = options.limit ?? RECENT_MESSAGES_PAGE_SIZE
      const params: unknown[] = [sessionId]

      let sql = "SELECT * FROM messages WHERE session_id = ?"

      if (options.includeSystem !== true) {
        sql += " AND role != 'system'"
      }

      if (options.beforeMessageId) {
        const cursor = db.prepare("SELECT created_at, id FROM messages WHERE id = ?")
          .get(options.beforeMessageId) as { created_at: number; id: string } | undefined
        if (cursor) {
          sql += " AND (created_at < ? OR (created_at = ? AND id < ?))"
          params.push(cursor.created_at, cursor.created_at, cursor.id)
        }
      }

      sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
      params.push(limit + 1)

      const rows = db.prepare(sql).all(...params) as MessageRow[]
      const hasMore = rows.length > limit
      const pageRows = hasMore ? rows.slice(0, limit) : rows
      const messages = pageRows.map(rowToChatMessage).reverse()

      return {
        items: messages,
        hasMore,
        nextBeforeMessageId: hasMore ? messages[0]?.id : undefined,
      }
    },

    async listMessagesByRequest(requestId) {
      const rows = db.prepare(
        "SELECT * FROM messages WHERE request_id = ? ORDER BY created_at ASC, id ASC"
      ).all(requestId) as MessageRow[]
      return rows.map(rowToChatMessage)
    },

    async deleteMessagesBySession(sessionId) {
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId)
    },
  }
}
