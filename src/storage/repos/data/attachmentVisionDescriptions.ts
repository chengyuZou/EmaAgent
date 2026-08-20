// attachment_vision_descriptions 的 SQL 层:Vision 文本派生的查找、写入、LRU 维护。
// 文本直接存表,不再有独立文件;attachment 删除时级联消失。
import type { SqliteDb } from '../../database/database.js';

export interface AttachmentVisionDescriptionRow {
  attachment_id:        string;
  provider_id:   string;
  model_id:             string;
  text:                 string;
  byte_size:            number;
  created_at:           number;
  last_accessed_at:     number;
}

export interface AttachmentVisionDescriptionKey {
  attachmentId:       string;
  providerId:   string;
  modelId:            string;
}

export class AttachmentVisionDescriptionsRepo {
  constructor(private readonly db: SqliteDb) {}

  find(key: AttachmentVisionDescriptionKey): AttachmentVisionDescriptionRow | undefined {
    return this.db.prepare(`
      SELECT * FROM attachment_vision_descriptions
       WHERE attachment_id = ? AND provider_id = ? AND model_id = ?
    `).get(
      key.attachmentId, key.providerId, key.modelId,
    ) as AttachmentVisionDescriptionRow | undefined;
  }

  upsert(key: AttachmentVisionDescriptionKey, text: string, byteSize: number, now: number): void {
    this.db.prepare(`
      INSERT INTO attachment_vision_descriptions (
        attachment_id, provider_id, model_id,
        text, byte_size, created_at, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attachment_id, provider_id, model_id)
      DO UPDATE SET text = excluded.text, byte_size = excluded.byte_size,
                    last_accessed_at = excluded.last_accessed_at
    `).run(
      key.attachmentId, key.providerId, key.modelId,
      text, byteSize, now, now,
    );
  }

  touch(key: AttachmentVisionDescriptionKey, now: number): void {
    this.db.prepare(`
      UPDATE attachment_vision_descriptions SET last_accessed_at = ?
       WHERE attachment_id = ? AND provider_id = ? AND model_id = ?
    `).run(
      now, key.attachmentId, key.providerId, key.modelId,
    );
  }

  /** TTL 清理:最后访问早于 cutoff 的批次。 */
  listAccessedBefore(cutoff: number, limit: number): AttachmentVisionDescriptionRow[] {
    return this.db.prepare(`
      SELECT * FROM attachment_vision_descriptions
       WHERE last_accessed_at < ?
       ORDER BY last_accessed_at ASC, attachment_id ASC
       LIMIT ?
    `).all(cutoff, limit) as AttachmentVisionDescriptionRow[];
  }

  /** 超预算清理:最久未访问优先。 */
  listOldest(limit: number): AttachmentVisionDescriptionRow[] {
    return this.db.prepare(`
      SELECT * FROM attachment_vision_descriptions
       ORDER BY last_accessed_at ASC, attachment_id ASC
       LIMIT ?
    `).all(limit) as AttachmentVisionDescriptionRow[];
  }

  deleteRows(rows: readonly AttachmentVisionDescriptionKey[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(`
      DELETE FROM attachment_vision_descriptions
       WHERE attachment_id = ? AND provider_id = ? AND model_id = ?
    `);
    let deleted = 0;
    this.db.transaction(() => {
      for (const key of rows) {
        deleted += stmt.run(
          key.attachmentId, key.providerId, key.modelId,
        ).changes;
      }
    })();
    return deleted;
  }

  totalBytes(): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(byte_size), 0) AS total FROM attachment_vision_descriptions`,
    ).get() as { total: number };
    return row.total;
  }
}
