import type { SqliteDb } from '../database.js';
import type { SessionId, CharacterCardId } from '@ema-agent/contracts';

export interface SessionRow {
  id: string;
  title: string;
  character_card_id: string;
  workspace_root: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  meta_json: string;
}

export interface SessionInsert {
  id: SessionId;
  title: string;
  characterCardId: CharacterCardId;
  workspaceRoot?: string;
  createdAt: number;
  updatedAt: number;
}

export class SessionsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(s: SessionInsert): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, character_card_id, workspace_root, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title, s.characterCardId, s.workspaceRoot ?? null, s.createdAt, s.updatedAt);
  }

  findById(id: SessionId): SessionRow | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
  }

  listActive(limit = 50): SessionRow[] {
    return this.db
      .prepare(
        'SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?',
      )
      .all(limit) as SessionRow[];
  }

  updateTitle(id: SessionId, title: string, updatedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, updatedAt, id);
  }

  touch(id: SessionId, updatedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(updatedAt, id);
  }

  archive(id: SessionId, archivedAt: number): void {
    this.db
      .prepare('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archivedAt, archivedAt, id);
  }

  delete(id: SessionId): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}
