/**
 * Session 仓储实现 —— 纯 SQLite。
 *
 * Repository 接口定义在本文件内部，不依赖 core-types 导出（已移除）。
 * 实体/ID 类型从 @ema-agent/core-types 导入。
 */

import type { Database } from "better-sqlite3";
import type {
  SessionState,
  SessionSummary,
  CreateSessionInput,
  SessionTitleStatus,
  SessionId,
  EmaMode,
} from "@ema-agent/core-types";

// ==========================================
// SessionRepository 接口（storage-sql 内部契约）
// ==========================================

export interface SessionRepository {
  getById(sessionId: SessionId): Promise<SessionState | null>;
  create(input: CreateSessionInput): Promise<SessionState>;
  save(session: SessionState): Promise<void>;
  list(): Promise<SessionSummary[]>;
  updateTitle(sessionId: SessionId, title: string, status?: SessionTitleStatus): Promise<void>;
  delete(sessionId: SessionId): Promise<void>;
  updateLastMode(sessionId: SessionId, mode: EmaMode): Promise<void>;
}

// ==========================================
// Row → Entity 映射
// ==========================================

function rowToSessionState(row: any): SessionState {
  return {
    id: row.id,
    title: row.title,
    lastMode: row.last_mode,
    fullAccess: Boolean(row.full_access),
    activeSkills: JSON.parse(row.active_skills || "[]"),
    titleStatus: row.title_status,
    titleUpdatedAt: row.title_updated_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ==========================================
// 工厂函数
// ==========================================

export function createSessionRepository(db: Database): SessionRepository {
  return {
    async getById(sessionId: SessionId) {
      const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
      return row ? rowToSessionState(row) : null;
    },

    async create(input: CreateSessionInput) {
      const now = input.createdAt ?? Date.now();
      const title = input.title ?? "New Chat";
      const lastMode = input.lastMode ?? "chat";

      db.prepare(`
        INSERT INTO sessions (id, title, last_mode, active_skills, created_at, updated_at)
        VALUES (?, ?, ?, '[]', ?, ?)
      `).run(input.id, title, lastMode, now, now);

      return this.getById(input.id) as Promise<SessionState>;
    },

    async save(session: SessionState) {
      db.prepare(`
        UPDATE sessions SET
          title = ?,
          last_mode = ?,
          full_access = ?,
          active_skills = ?,
          title_status = ?,
          title_updated_at = ?,
          updated_at = ?
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
      );
    },

    async delete(sessionId: SessionId) {
      const deleteSession = db.transaction(() => {
        db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
        db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
      });
      deleteSession();
    },

    async list(): Promise<SessionSummary[]> {
      const rows = db.prepare(`
        SELECT s.id, s.title, s.updated_at, s.last_mode, COUNT(m.id) as msg_count
        FROM sessions s
        LEFT JOIN messages m ON s.id = m.session_id
        GROUP BY s.id
        ORDER BY s.updated_at DESC
      `).all() as any[];

      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        lastMode: row.last_mode,
        updatedAt: row.updated_at,
        messageCount: Number(row.msg_count),
      }));
    },

    async updateTitle(sessionId: SessionId, title: string, status?: SessionTitleStatus) {
      const dbStatus = status ?? "default";
      db.prepare(`
        UPDATE sessions SET title = ?, title_status = ?, title_updated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(title, dbStatus, Date.now(), Date.now(), sessionId);
    },

    async updateLastMode(sessionId: SessionId, mode: EmaMode) {
      db.prepare(`
        UPDATE sessions SET last_mode = ?, updated_at = ? WHERE id = ?
      `).run(mode, Date.now(), sessionId);
    },
  };
}