// attachment_pasted_texts 的 SQL 层:粘贴文本落盘 txt 的账本。
// turn_id NULL = 已落盘未被消费;发送时 claimForTurn 盖章,孤儿清扫只看 NULL 行。
import type { SqliteDb } from '../../database/database.js';

export interface AttachmentPastedTextRow {
  path:       string;
  session_id: string;
  turn_id:    string | null;
  byte_size:  number;
  created_at: number;
}

/** 入账时 Turn 还不存在(粘贴即落盘),turn_id 由发送时盖章,不在插入列里。 */
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
   * 发送盖章:把本轮输入消费的行标记到当前 Turn。
   * 返回没有盖上的 path(未入账或不属于该 Session),调用方据此硬失败。
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

  /** 清扫账本侧:该 Session 贴了没发且超龄的行。 */
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
