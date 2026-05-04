/**
 * Artifact 仓储 — artifacts 表 CRUD。
 */

import type { Database } from "better-sqlite3"
import type {
  ArtifactSummary,
  ArtifactDetail,
  ArtifactPayloadRef,
  ArtifactKind,
  ArtifactStatus,
  ArtifactParams,
  ArtifactPage,
  ListArtifactsOptions,
  ArtifactId,
  SessionId,
  RequestId,
} from "@ema-agent/core-types"

export interface CreateArtifactInput {
  id: ArtifactId
  sessionId: SessionId
  requestId: RequestId
  kind: ArtifactKind
  title: string
  description?: string
  mime?: string
  targetPaths?: string[]
  params?: ArtifactParams
  status?: ArtifactStatus
  payloadType?: "inline" | "file" | "db"
  payloadContent?: string
  binaryBase64?: string
  contentHash?: string
  createdAt?: number
}

export interface UpdateArtifactInput {
  artifactId: ArtifactId
  title?: string
  description?: string
  mime?: string
  targetPaths?: string[]
  params?: ArtifactParams
  status?: ArtifactStatus
  payloadType?: "inline" | "file" | "db"
  payloadContent?: string
  binaryBase64?: string
  contentHash?: string
}

export interface ArtifactRepository {
  createArtifact(input: CreateArtifactInput): Promise<ArtifactSummary>
  getArtifactById(artifactId: ArtifactId): Promise<ArtifactDetail | null>
  updateArtifact(input: UpdateArtifactInput): Promise<void>
  listArtifactsBySession(sessionId: SessionId, options?: ListArtifactsOptions): Promise<ArtifactPage>
  listArtifactsByRequest(requestId: RequestId): Promise<ArtifactSummary[]>
  deleteArtifact(artifactId: ArtifactId): Promise<void>
}

interface ArtifactRow {
  id: string
  session_id: string
  request_id: string
  kind: string
  title: string
  description: string | null
  mime: string
  target_paths: string | null
  params: string | null
  status: string
  payload_type: string
  payload_content: string | null
  binary_base64: string | null
  content_hash: string | null
  created_at: number
  updated_at: number
}

function rowToSummary(row: ArtifactRow): ArtifactSummary {
  return {
    id: row.id as ArtifactId,
    sessionId: row.session_id as SessionId,
    requestId: row.request_id as RequestId,
    kind: row.kind as ArtifactKind,
    title: row.title,
    description: row.description ?? undefined,
    mime: row.mime,
    targetPaths: row.target_paths ? JSON.parse(row.target_paths) as string[] : undefined,
    params: row.params ? JSON.parse(row.params) as ArtifactParams : undefined,
    status: row.status as ArtifactStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToDetail(row: ArtifactRow): ArtifactDetail {
  const payload: ArtifactPayloadRef =
    row.payload_type === "file"
      ? { type: "file", path: row.payload_content ?? "" }
      : row.payload_type === "db"
        ? { type: "db", key: row.payload_content ?? "" }
        : { type: "inline", content: row.payload_content ?? "" }

  return {
    summary: rowToSummary(row),
    payload,
    binaryBase64: row.binary_base64 ?? undefined,
    contentHash: row.content_hash ?? undefined,
  }
}

export function createArtifactRepository(db: Database): ArtifactRepository {
  return {
    async createArtifact(input) {
      const now = input.createdAt ?? Date.now()

      db.prepare(`
        INSERT INTO artifacts (
          id, session_id, request_id, kind, title, description, mime,
          target_paths, params, status, payload_type, payload_content,
          binary_base64, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.sessionId, input.requestId, input.kind, input.title,
        input.description ?? null, input.mime ?? "text/plain",
        input.targetPaths ? JSON.stringify(input.targetPaths) : null,
        input.params ? JSON.stringify(input.params) : null,
        input.status ?? "draft", input.payloadType ?? "inline",
        input.payloadContent ?? null, input.binaryBase64 ?? null,
        input.contentHash ?? null, now, now,
      )

      const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(input.id) as ArtifactRow
      return rowToSummary(row)
    },

    async getArtifactById(artifactId) {
      const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as ArtifactRow | undefined
      return row ? rowToDetail(row) : null
    },

    async updateArtifact(input) {
      const sets: string[] = []
      const vals: unknown[] = []

      if (input.title !== undefined) { sets.push("title = ?"); vals.push(input.title) }
      if (input.description !== undefined) { sets.push("description = ?"); vals.push(input.description) }
      if (input.mime !== undefined) { sets.push("mime = ?"); vals.push(input.mime) }
      if (input.targetPaths !== undefined) { sets.push("target_paths = ?"); vals.push(input.targetPaths ? JSON.stringify(input.targetPaths) : null) }
      if (input.params !== undefined) { sets.push("params = ?"); vals.push(input.params ? JSON.stringify(input.params) : null) }
      if (input.status !== undefined) { sets.push("status = ?"); vals.push(input.status) }
      if (input.payloadType !== undefined) { sets.push("payload_type = ?"); vals.push(input.payloadType) }
      if (input.payloadContent !== undefined) { sets.push("payload_content = ?"); vals.push(input.payloadContent) }
      if (input.binaryBase64 !== undefined) { sets.push("binary_base64 = ?"); vals.push(input.binaryBase64) }
      if (input.contentHash !== undefined) { sets.push("content_hash = ?"); vals.push(input.contentHash) }

      if (sets.length === 0) return

      sets.push("updated_at = ?")
      vals.push(Date.now(), input.artifactId)
      db.prepare(`UPDATE artifacts SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
    },

    async listArtifactsBySession(sessionId, options) {
      const limit = options?.limit ?? 20
      const params: unknown[] = [sessionId]

      let sql = "SELECT * FROM artifacts WHERE session_id = ?"

      if (options?.beforeCreatedAt) {
        if (options.beforeArtifactId) {
          sql += " AND (created_at < ? OR (created_at = ? AND id < ?))"
          params.push(options.beforeCreatedAt, options.beforeCreatedAt, options.beforeArtifactId)
        } else {
          sql += " AND created_at < ?"
          params.push(options.beforeCreatedAt)
        }
      }

      if (options?.kinds && options.kinds.length > 0) {
        sql += ` AND kind IN (${options.kinds.map(() => "?").join(",")})`
        params.push(...options.kinds)
      }

      if (options?.statuses && options.statuses.length > 0) {
        sql += ` AND status IN (${options.statuses.map(() => "?").join(",")})`
        params.push(...options.statuses)
      }

      sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
      params.push(limit + 1)

      const rows = db.prepare(sql).all(...params) as ArtifactRow[]
      const hasMore = rows.length > limit
      const items = hasMore ? rows.slice(0, limit) : rows

      return {
        items: items.map(rowToSummary),
        hasMore,
        nextBeforeCreatedAt: hasMore ? items[items.length - 1]!.created_at : undefined,
        nextBeforeArtifactId: hasMore ? items[items.length - 1]!.id as ArtifactId : undefined,
      }
    },

    async listArtifactsByRequest(requestId) {
      const rows = db.prepare(
        "SELECT * FROM artifacts WHERE request_id = ? ORDER BY created_at ASC"
      ).all(requestId) as ArtifactRow[]
      return rows.map(rowToSummary)
    },

    async deleteArtifact(artifactId) {
      db.prepare("DELETE FROM artifacts WHERE id = ?").run(artifactId)
    },
  }
}
