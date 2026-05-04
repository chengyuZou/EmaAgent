/**
 * Session 仓储 — sessions 表 CRUD。
 */

import type { Database } from "better-sqlite3"
import type {
  SessionState,
  SessionSummary,
  CreateSessionInput,
  SessionTitleStatus,
  SessionId,
  EmaMode,
} from "@ema-agent/core-types"
import { SESSION_TITLE_MAX_LENGTH } from "@ema-agent/constants-core"

export interface SessionRepository {
  getById(sessionId: SessionId): Promise<SessionState | null>
  create(input: CreateSessionInput): Promise<SessionState>
  save(session: SessionState): Promise<void>
  list(): Promise<SessionSummary[]>
  updateTitle(sessionId: SessionId, title: string, status?: SessionTitleStatus): Promise<void>
  delete(sessionId: SessionId): Promise<void>
  updateLastMode(sessionId: SessionId, mode: EmaMode): Promise<void>
}

interface SessionRow {
  id: string
  title: string
  last_mode: string
  full_access: number
  active_skills: string
  title_status: string
  title_updated_at: number | null
  created_at: number
  updated_at: number
}

function rowToSessionState(row: SessionRow): SessionState {
  return {
    id: row.id as SessionId,
    title: row.title,
    lastMode: row.last_mode as EmaMode,
    fullAccess: Boolean(row.full_access),
    activeSkills: JSON.parse(row.active_skills || "[]") as string[],
    titleStatus: row.title_status as SessionTitleStatus,
    titleUpdatedAt: row.title_updated_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createSessionRepository(db: Database): SessionRepository {
  return {
    async getById(sessionId) {
      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined
      return row ? rowToSessionState(row) : null
    },

    async create(input) {
      const now = input.createdAt ?? Date.now()
      const title = input.title ?? "New Chat"
      const lastMode = input.lastMode ?? "chat"

      db.prepare(`
        INSERT INTO sessions (id, title, last_mode, active_skills, created_at, updated_at)
        VALUES (?, ?, ?, '[]', ?, ?)
      `).run(input.id, title, lastMode, now, now)

      return (await this.getById(input.id))!
    },

    async save(session) {
      db.prepare(`
        UPDATE sessions SET
          title = ?, last_mode = ?, full_access = ?, active_skills = ?,
          title_status = ?, title_updated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        session.title,
        session.lastMode,
        session.fullAccess ? 1 : 0,
        JSON.stringify(session.activeSkills),
        session.titleStatus,
        session.titleUpdatedAt ?? null,
        Date.now(),
        session.id,
      )
    },

    async delete(sessionId) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId)
    },

    async list() {
      const rows = db.prepare(`
        SELECT s.id, s.title, s.updated_at, s.last_mode, COUNT(m.id) AS msg_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        GROUP BY s.id
        ORDER BY s.updated_at DESC
      `).all() as Array<{ id: string; title: string; updated_at: number; last_mode: string; msg_count: number }>

      return rows.map((row) => ({
        id: row.id as SessionId,
        title: row.title.length > SESSION_TITLE_MAX_LENGTH
          ? row.title.slice(0, SESSION_TITLE_MAX_LENGTH) + "…"
          : row.title,
        lastMode: row.last_mode as EmaMode,
        updatedAt: row.updated_at,
        messageCount: Number(row.msg_count),
      }))
    },

    async updateTitle(sessionId, title, status) {
      db.prepare(`
        UPDATE sessions SET title = ?, title_status = ?, title_updated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(title, status ?? "default", Date.now(), Date.now(), sessionId)
    },

    async updateLastMode(sessionId, mode) {
      db.prepare("UPDATE sessions SET last_mode = ?, updated_at = ? WHERE id = ?")
        .run(mode, Date.now(), sessionId)
    },
  }
}
