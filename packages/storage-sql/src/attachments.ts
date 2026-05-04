import type { Database } from "better-sqlite3"
import type {
  AttachmentChunk,
  AttachmentId,
  AttachmentRecord,
  AttachmentRecallHit,
  AttachmentStatus,
  SessionId,
} from "@ema-agent/core-types"

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

export function createAttachmentRepository(db: Database): AttachmentRepository {
  return {
    async createAttachment(input) {
      const now = input.createdAt ?? Date.now()
      db.prepare(`
        INSERT INTO attachments (
          id, session_id, file_name, mime, size_bytes, sha256,
          status, text_preview, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        input.fileName,
        input.mime,
        input.sizeBytes,
        input.sha256,
        input.status ?? "uploaded",
        input.textPreview ?? null,
        now,
        now,
      )

      return this.getById(input.id) as Promise<AttachmentRecord>
    },

    async updateStatus(input) {
      db.prepare(`
        UPDATE attachments
        SET status = ?, text_preview = COALESCE(?, text_preview), error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(input.status, input.textPreview ?? null, input.errorMessage ?? null, Date.now(), input.attachmentId)
    },

    async getById(attachmentId) {
      const row = db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(attachmentId)
      return row ? rowToAttachment(row) : null
    },

    async listBySession(sessionId) {
      const rows = db.prepare(`
        SELECT * FROM attachments
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
      `).all(sessionId) as unknown[]
      return rows.map(rowToAttachment)
    },

    async replaceChunks(attachmentId, chunks) {
      const write = db.transaction(() => {
        db.prepare(`DELETE FROM attachment_chunks WHERE attachment_id = ?`).run(attachmentId)
        const stmt = db.prepare(`
          INSERT INTO attachment_chunks (
            id, attachment_id, session_id, chunk_index, text, token_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        for (const chunk of chunks) {
          stmt.run(
            chunk.id,
            chunk.attachmentId,
            chunk.sessionId,
            chunk.chunkIndex,
            chunk.text,
            chunk.tokenCount,
            chunk.createdAt ?? Date.now(),
          )
        }
      })
      write()
    },

    async listChunks(attachmentId) {
      const rows = db.prepare(`
        SELECT * FROM attachment_chunks
        WHERE attachment_id = ?
        ORDER BY chunk_index ASC
      `).all(attachmentId) as unknown[]
      return rows.map(rowToChunk)
    },

    async recall(sessionId, query, limit = 5) {
      const rows = db.prepare(`
        SELECT
          c.*,
          a.id AS a_id,
          a.session_id AS a_session_id,
          a.file_name AS a_file_name,
          a.mime AS a_mime,
          a.size_bytes AS a_size_bytes,
          a.sha256 AS a_sha256,
          a.status AS a_status,
          a.text_preview AS a_text_preview,
          a.error_message AS a_error_message,
          a.created_at AS a_created_at,
          a.updated_at AS a_updated_at
        FROM attachment_chunks c
        JOIN attachments a ON a.id = c.attachment_id
        WHERE c.session_id = ? AND lower(c.text) LIKE ?
        ORDER BY c.chunk_index ASC
        LIMIT ?
      `).all(sessionId, `%${query.toLowerCase()}%`, limit) as any[]

      return rows.map((row): AttachmentRecallHit => ({
        attachment: rowToAttachment({
          id: row.a_id,
          session_id: row.a_session_id,
          file_name: row.a_file_name,
          mime: row.a_mime,
          size_bytes: row.a_size_bytes,
          sha256: row.a_sha256,
          status: row.a_status,
          text_preview: row.a_text_preview,
          error_message: row.a_error_message,
          created_at: row.a_created_at,
          updated_at: row.a_updated_at,
        }),
        chunk: rowToChunk(row),
        score: countOccurrences(String(row.text).toLowerCase(), query.toLowerCase()),
      }))
    },
  }
}

function rowToAttachment(row: any): AttachmentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    fileName: row.file_name,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    status: row.status,
    textPreview: row.text_preview ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToChunk(row: any): AttachmentChunk {
  return {
    id: row.id,
    attachmentId: row.attachment_id,
    sessionId: row.session_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  }
}

function countOccurrences(text: string, query: string): number {
  if (!query) {
    return 0
  }
  return text.split(query).length - 1
}
