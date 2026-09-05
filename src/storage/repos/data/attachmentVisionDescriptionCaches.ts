// attachment_vision_descriptions_caches 的 SQL 层:Vision 文本派生的查找、写入、LRU 维护。
// 主键是图片受管副本路径;图片行删除时级联消失。
import type { SqliteDb } from '../../database/database.js';

export interface AttachmentVisionDescriptionCacheRow {
  path:             string;
  text:             string;
  byte_size:        number;
  created_at:       number;
  last_accessed_at: number;
}

export class AttachmentVisionDescriptionCachesRepo {
  constructor(private readonly db: SqliteDb) {}

  find(path: string): AttachmentVisionDescriptionCacheRow | undefined {
    return this.db.prepare(`
      SELECT * FROM attachment_vision_descriptions_caches
       WHERE path = ?
    `).get(path) as AttachmentVisionDescriptionCacheRow | undefined;
  }

  upsert(path: string, text: string, byteSize: number, now: number): void {
    this.db.prepare(`
      INSERT INTO attachment_vision_descriptions_caches (
        path, text, byte_size, created_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path)
      DO UPDATE SET text = excluded.text, byte_size = excluded.byte_size,
                    last_accessed_at = excluded.last_accessed_at
    `).run(path, text, byteSize, now, now);
  }

  touch(path: string, now: number): void {
    this.db.prepare(`
      UPDATE attachment_vision_descriptions_caches SET last_accessed_at = ?
       WHERE path = ?
    `).run(now, path);
  }

  /** TTL 清理:最后访问早于 cutoff 的批次。 */
  listAccessedBefore(cutoff: number, limit: number): AttachmentVisionDescriptionCacheRow[] {
    return this.db.prepare(`
      SELECT * FROM attachment_vision_descriptions_caches
       WHERE last_accessed_at < ?
       ORDER BY last_accessed_at ASC, path ASC
       LIMIT ?
    `).all(cutoff, limit) as AttachmentVisionDescriptionCacheRow[];
  }

  /** 超预算清理:最久未访问优先。 */
  listOldest(limit: number): AttachmentVisionDescriptionCacheRow[] {
    return this.db.prepare(`
      SELECT * FROM attachment_vision_descriptions_caches
       ORDER BY last_accessed_at ASC, path ASC
       LIMIT ?
    `).all(limit) as AttachmentVisionDescriptionCacheRow[];
  }

  deleteRows(paths: readonly string[]): number {
    if (paths.length === 0) return 0;
    const stmt = this.db.prepare(`
      DELETE FROM attachment_vision_descriptions_caches
       WHERE path = ?
    `);
    let deleted = 0;
    this.db.transaction(() => {
      for (const path of paths) {
        deleted += stmt.run(path).changes;
      }
    })();
    return deleted;
  }

  totalBytes(): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(byte_size), 0) AS total FROM attachment_vision_descriptions_caches`,
    ).get() as { total: number };
    return row.total;
  }
}
