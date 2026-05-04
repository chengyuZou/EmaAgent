/**
 * Attachment 仓储 — attachments + attachment_chunks 表 CRUD。
 */

import type { Database } from "better-sqlite3"
import type {
  AttachmentChunk,
  AttachmentId,
  AttachmentRecord,
  AttachmentRecallHit,
  AttachmentStatus,
  SessionId,
} from "@ema-agent/core-types"
import { MEMORY_RECALL_LIMIT } from "@ema-agent/constants-core"
import { escapeLike } from "../fts.js"

export interface CreateAttachmentInput {
  id: AttachmentId
  sessionId: SessionId
  fileName: string
  mime: string
  sizeBytes: number
  sha256: string
  status?: AttachmentStatus
  textPreview?: string
  createdAt?: number
}

export interface UpsertAttachmentChunkInput {
  id: string
  attachmentId: AttachmentId
  sessionId: SessionId
  chunkIndex: number
  text: string
  tokenCount: number
  createdAt?: number
}

export interface AttachmentRepository {
  createAttachment(input: CreateAttachmentInput): Promise<AttachmentRecord>
  updateStatus(input: { attachmentId: AttachmentId; status: AttachmentStatus; textPreview?: string; errorMessage?: string }): Promise<void>
  getById(attachmentId: AttachmentId): Promise<AttachmentRecord | null>
  listBySession(sessionId: SessionId): Promise<AttachmentRecord[]>
  replaceChunks(attachmentId: AttachmentId, chunks: UpsertAttachmentChunkInput[]): Promise<void>
  listChunks(attachmentId: AttachmentId): Promise<AttachmentChunk[]>
  recall(sessionId: SessionId, query: string, limit?: number): Promise<AttachmentRecallHit[]>
}

interface AttachmentRow {
  id: string
  session_id: string
  file_name: string
  mime: string
  size_bytes: number
  sha256: string
  status: string
  text_preview: string | null
  error_message: string | null
  created_at: number
  updated_at: number
}

interface AttachmentChunkRow {
  id: string
  attachment_id: string
  session_id: string
  chunk_index: number
  text: string
  token_count: number
  created_at: number
}

function rowToAttachment(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id as AttachmentId,
    sessionId: row.session_id as SessionId,
    fileName: row.file_name,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    status: row.status as AttachmentStatus,
    textPreview: row.text_preview ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToChunk(row: AttachmentChunkRow): AttachmentChunk {
  return {
    id: row.id,
    attachmentId: row.attachment_id as AttachmentId,
    sessionId: row.session_id as SessionId,
    chunkIndex: row.chunk_index,
    text: row.text,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  }
}

function countOccurrences(text: string, query: string): number {
  if (!query) return 0
  return text.split(query).length - 1
}

export function createAttachmentRepository(db: Database): AttachmentRepository {
  return {
    async createAttachment(input) {
      const now = input.createdAt ?? Date.now()
      db.prepare(`
        INSERT INTO attachments (id, session_id, file_name, mime, size_bytes, sha256, status, text_preview, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.id, input.sessionId, input.fileName, input.mime, input.sizeBytes, input.sha256, input.status ?? "uploaded", input.textPreview ?? null, now, now)

      return (await this.getById(input.id))!
    },

    async updateStatus(input) {
      db.prepare(`
        UPDATE attachments
        SET status = ?, text_preview = COALESCE(?, text_preview), error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(input.status, input.textPreview ?? null, input.errorMessage ?? null, Date.now(), input.attachmentId)
    },

    async getById(attachmentId) {
      const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(attachmentId) as AttachmentRow | undefined
      return row ? rowToAttachment(row) : null
    },

    async listBySession(sessionId) {
      const rows = db.prepare(
        "SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at DESC, id DESC"
      ).all(sessionId) as AttachmentRow[]
      return rows.map(rowToAttachment)
    },

    async replaceChunks(attachmentId, chunks) {
      const write = db.transaction(() => {
        db.prepare("DELETE FROM attachment_chunks WHERE attachment_id = ?").run(attachmentId)
        const stmt = db.prepare(
          "INSERT INTO attachment_chunks (id, attachment_id, session_id, chunk_index, text, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        for (const chunk of chunks) {
          stmt.run(chunk.id, chunk.attachmentId, chunk.sessionId, chunk.chunkIndex, chunk.text, chunk.tokenCount, chunk.createdAt ?? Date.now())
        }
      })
      write()
    },

    async listChunks(attachmentId) {
      const rows = db.prepare(
        "SELECT * FROM attachment_chunks WHERE attachment_id = ? ORDER BY chunk_index ASC"
      ).all(attachmentId) as AttachmentChunkRow[]
      return rows.map(rowToChunk)
    },

    async recall(sessionId, query, limit = MEMORY_RECALL_LIMIT) {
      const likePattern = `%${escapeLike(query.toLowerCase())}%`
      const rows = db.prepare(
        "SELECT * FROM attachment_chunks WHERE session_id = ? AND lower(text) LIKE ? ESCAPE '\\' ORDER BY chunk_index ASC LIMIT ?"
      ).all(sessionId, likePattern, limit) as AttachmentChunkRow[]

      return rows.map((row): AttachmentRecallHit => ({
        attachment: rowToAttachment(db.prepare("SELECT * FROM attachments WHERE id = ?").get(row.attachment_id) as AttachmentRow),
        chunk: rowToChunk(row),
        score: countOccurrences(row.text.toLowerCase(), query.toLowerCase()),
      }))
    },
  }
}
