import type { SqliteDb } from '../../database/database.js';

export interface AttachmentPastedTextRow {
  path:       string;
  session_id: string;
  turn_id:    string | null;
  byte_size:  number;
  created_at: number;
}

/** 粘贴到输入框时 Turn 还不存在(粘贴即落盘),turn_id 由发送时盖章,不在插入列里 */
export type AttachmentPastedTextInsertRow = Omit<AttachmentPastedTextRow, 'turn_id'>;

export class AttachmentPastedTextsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(row: AttachmentPastedTextInsertRow): void {
    this.db.prepare(`
      INSERT INTO attachment_pasted_texts (path, session_id, byte_size, created_at)
      VALUES (?, ?, ?, ?)
    `).run(row.path, row.session_id, row.byte_size, row.created_at);
  }

  /**
   * 发送前认领本次消息引用的粘贴文本, 将有效条目绑定到当前 Turn.
   * @param paths 发送消息引用的粘贴文本路径
   * @returns 无法认领的 path, 例如已被用户删除 未入账或不属于当前 Session.
   */
  claimForTurn(
    sessionId: string,
    turnId: string,
    paths: readonly string[],
  ): string[] {
    const stmt = this.db.prepare(`
      UPDATE attachment_pasted_texts SET turn_id = ?
       WHERE session_id = ? AND path = ?
    `);
    const missing: string[] = [];
    this.db.transaction(() => {
      for (const path of paths) {
        if (stmt.run(turnId, sessionId, path).changes === 0) missing.push(path);
      }
    })();
    return missing;
  }

  listBySession(sessionId: string): AttachmentPastedTextRow[] {
    return this.db.prepare(`
      SELECT * FROM attachment_pasted_texts
       WHERE session_id = ?
       ORDER BY created_at DESC, path ASC
    `).all(sessionId) as AttachmentPastedTextRow[];
  }

  /** 返回指定 Session 中, 未被认领且创建时间早于指定时间的粘贴文本行 */
  listUnsentBefore(sessionId: string, cutoff: number): AttachmentPastedTextRow[] {
    return this.db.prepare(`
      SELECT * FROM attachment_pasted_texts
       WHERE session_id = ? AND turn_id IS NULL AND created_at < ?
       ORDER BY created_at ASC, path ASC
    `).all(sessionId, cutoff) as AttachmentPastedTextRow[];
  }

  deleteByPaths(paths: readonly string[]): number {
    if (paths.length === 0) return 0;
    const stmt = this.db.prepare(`DELETE FROM attachment_pasted_texts WHERE path = ?`);
    let deleted = 0;
    this.db.transaction(() => {
      for (const path of paths) {
        deleted += stmt.run(path).changes;
      }
    })();
    return deleted;
  }
}
