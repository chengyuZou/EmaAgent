// turn_attachments 的 SQL 层:判别联合行映射、单事务批量写入、按 Turn/Session 查询。
import type { SqliteDb } from '../../database/database.js';

export type AttachmentRowKind = 'file' | 'image';

export interface AttachmentRow {
  id:                 string;
  turn_id:            string;
  session_id:         string;
  kind:               AttachmentRowKind;
  name:               string;
  mime:               string;
  source_path:        string;
  byte_size:          number;
  source_modified_at: number;
  image_path:         string | null;
  image_byte_size:    number | null;
  created_at:         number;
}

export type AttachmentInsertRow = Omit<AttachmentRow, never>;

export class AttachmentRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 整批附件一个事务写入:用户输入与附件记录整体成功或整体失败。 */
  insertMany(rows: readonly AttachmentInsertRow[]): void {
    this.db.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO turn_attachments (
          id, turn_id, session_id, kind, name, mime,
          source_path, byte_size, source_modified_at,
          image_path, image_byte_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        stmt.run(
          row.id, row.turn_id, row.session_id, row.kind, row.name, row.mime,
          row.source_path, row.byte_size, row.source_modified_at,
          row.image_path, row.image_byte_size, row.created_at,
        );
      }
    })();
  }

  findByIds(ids: readonly string[]): AttachmentRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT * FROM turn_attachments WHERE id IN (${placeholders})`,
    ).all(...ids) as AttachmentRow[];
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
}
