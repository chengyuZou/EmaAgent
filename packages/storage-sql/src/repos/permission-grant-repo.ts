/**
 * Permission Grant 仓储 — permission_grants 表 CRUD。
 */

import type { Database } from "better-sqlite3"
import type { PermissionGrantRecord, SessionId } from "@ema-agent/core-types"

export interface CreatePermissionGrantInput {
  id: string
  sessionId: SessionId
  toolName: string
  decision: "allow" | "deny"
  scope: "once" | "session" | "always"
  risk: string
  pathPattern?: string
  decidedAt?: number
  expiresAt?: number
}

export interface PermissionGrantRepository {
  create(input: CreatePermissionGrantInput): Promise<PermissionGrantRecord>
  getById(id: string): Promise<PermissionGrantRecord | null>
  listBySession(sessionId: SessionId): Promise<PermissionGrantRecord[]>
  /** 查找匹配的持久化授权（always 或当前 session 的 session 级授权）。 */
  findGrant(sessionId: SessionId, toolName: string): Promise<PermissionGrantRecord | null>
  delete(id: string): Promise<void>
  deleteBySession(sessionId: SessionId): Promise<void>
}

interface PermissionGrantRow {
  id: string
  session_id: string
  tool_name: string
  decision: string
  scope: string
  risk: string
  path_pattern: string | null
  decided_at: number
  expires_at: number | null
}

function rowToRecord(row: PermissionGrantRow): PermissionGrantRecord {
  return {
    id: row.id,
    sessionId: row.session_id as SessionId,
    toolName: row.tool_name,
    decision: row.decision as "allow" | "deny",
    scope: row.scope as "once" | "session" | "always",
    risk: row.risk,
    pathPattern: row.path_pattern ?? undefined,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at ?? undefined,
  }
}

export function createPermissionGrantRepository(db: Database): PermissionGrantRepository {
  return {
    async create(input) {
      const now = input.decidedAt ?? Date.now()
      db.prepare(`
        INSERT INTO permission_grants (id, session_id, tool_name, decision, scope, risk, path_pattern, decided_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.id, input.sessionId, input.toolName, input.decision, input.scope, input.risk, input.pathPattern ?? null, now, input.expiresAt ?? null)

      const row = db.prepare("SELECT * FROM permission_grants WHERE id = ?").get(input.id) as PermissionGrantRow
      return rowToRecord(row)
    },

    async getById(id) {
      const row = db.prepare("SELECT * FROM permission_grants WHERE id = ?").get(id) as PermissionGrantRow | undefined
      return row ? rowToRecord(row) : null
    },

    async listBySession(sessionId) {
      const rows = db.prepare(
        "SELECT * FROM permission_grants WHERE session_id = ? ORDER BY decided_at DESC"
      ).all(sessionId) as PermissionGrantRow[]
      return rows.map(rowToRecord)
    },

    async findGrant(sessionId, toolName) {
      // 优先匹配 always 级授权，其次当前 session 的 session 级授权
      const row = db.prepare(`
        SELECT * FROM permission_grants
        WHERE tool_name = ? AND (scope = 'always' OR (scope = 'session' AND session_id = ?))
        ORDER BY CASE scope WHEN 'always' THEN 0 WHEN 'session' THEN 1 END
        LIMIT 1
      `).get(toolName, sessionId) as PermissionGrantRow | undefined
      return row ? rowToRecord(row) : null
    },

    async delete(id) {
      db.prepare("DELETE FROM permission_grants WHERE id = ?").run(id)
    },

    async deleteBySession(sessionId) {
      db.prepare("DELETE FROM permission_grants WHERE session_id = ? AND scope != 'always'").run(sessionId)
    },
  }
}
