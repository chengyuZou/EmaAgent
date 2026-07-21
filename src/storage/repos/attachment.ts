import type { SqliteDb } from '../database.js';

export interface AttachmentRow {
  id:         string;
  turn_id:    string;
  session_id: string;
  name:       string;
  mime:       string;
  size:       number;
  mtime:      number;
  local_path: string;
  created_at: number;
}

export interface AttachmentInsert {
  id:        string;
  turnId:    string;
  sessionId: string;
  name:      string;
  mime:      string;
  size:      number;
  mtime:     number;
  localPath: string;
  createdAt: number;
}

export class AttachmentRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: AttachmentInsert): void {
    this.db.prepare(`
      INSERT INTO turn_attachments
        (id, turn_id, session_id, name, mime, size, mtime, local_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.turnId, row.sessionId,
      row.name, row.mime, row.size, row.mtime, row.localPath, row.createdAt,
    );
  }

  listByTurn(turnId: string): AttachmentRow[] {
    return this.db
      .prepare(`SELECT * FROM turn_attachments WHERE turn_id = ? ORDER BY created_at ASC`)
      .all(turnId) as AttachmentRow[];
  }

  listBySession(sessionId: string): AttachmentRow[] {
    return this.db
      .prepare(`SELECT * FROM turn_attachments WHERE session_id = ? ORDER BY created_at DESC`)
      .all(sessionId) as AttachmentRow[];
  }

  findById(id: string): AttachmentRow | undefined {
    return this.db
      .prepare(`SELECT * FROM turn_attachments WHERE id = ?`)
      .get(id) as AttachmentRow | undefined;
  }

  deleteById(id: string): void {
    this.db.prepare(`DELETE FROM turn_attachments WHERE id = ?`).run(id);
  }

  deleteByTurn(turnId: string): void {
    this.db.prepare(`DELETE FROM turn_attachments WHERE turn_id = ?`).run(turnId);
  }
}
