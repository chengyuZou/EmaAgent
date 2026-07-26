// 持久化图片规范化副本及其 Vision 文本派生索引，正文仍保存在受控文件中。
import type { SqliteDb } from '../database.js';

export type AttachmentVisionTask = 'auto' | 'caption' | 'ocr' | 'layout' | 'table';

export interface CachedAttachmentImageRow {
  content_sha256: string;
  relative_path: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  byte_size: number;
  width: number;
  height: number;
  created_at: number;
  last_used_at: number;
}

export interface AttachmentVisionDerivationRow {
  id: string;
  content_sha256: string;
  task: AttachmentVisionTask;
  provider_config_id: string;
  model_id: string;
  prompt_sha256: string;
  transform_version: string;
  language: string;
  relative_path: string;
  byte_size: number;
  created_at: number;
  last_used_at: number;
}

export interface AttachmentVisionDerivationIdentity {
  contentSha256: string;
  task: AttachmentVisionTask;
  providerConfigId: string;
  modelId: string;
  promptSha256: string;
  transformVersion: string;
  language: string;
}

export interface CachedAttachmentImageInsert {
  contentSha256: string;
  relativePath: string;
  mime: CachedAttachmentImageRow['mime'];
  byteSize: number;
  width: number;
  height: number;
  now: number;
}

export interface AttachmentVisionDerivationInsert extends AttachmentVisionDerivationIdentity {
  id: string;
  relativePath: string;
  byteSize: number;
  now: number;
}

export class AttachmentDerivationsRepo {
  constructor(private readonly db: SqliteDb) {}

  find(identity: AttachmentVisionDerivationIdentity): AttachmentVisionDerivationRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM attachment_vision_derivations
      WHERE content_sha256 = ?
        AND task = ?
        AND provider_config_id = ?
        AND model_id = ?
        AND prompt_sha256 = ?
        AND transform_version = ?
        AND language = ?
    `).get(
      identity.contentSha256,
      identity.task,
      identity.providerConfigId,
      identity.modelId,
      identity.promptSha256,
      identity.transformVersion,
      identity.language,
    ) as AttachmentVisionDerivationRow | undefined;
  }

  save(image: CachedAttachmentImageInsert, derivation: AttachmentVisionDerivationInsert): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO attachment_cached_images (
          content_sha256, relative_path, mime, byte_size,
          width, height, created_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_sha256) DO UPDATE SET
          relative_path = excluded.relative_path,
          mime = excluded.mime,
          byte_size = excluded.byte_size,
          width = excluded.width,
          height = excluded.height,
          last_used_at = excluded.last_used_at
      `).run(
        image.contentSha256,
        image.relativePath,
        image.mime,
        image.byteSize,
        image.width,
        image.height,
        image.now,
        image.now,
      );

      this.db.prepare(`
        INSERT INTO attachment_vision_derivations (
          id, content_sha256, task, provider_config_id, model_id,
          prompt_sha256, transform_version, language,
          relative_path, byte_size, created_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          content_sha256, task, provider_config_id, model_id,
          prompt_sha256, transform_version, language
        ) DO UPDATE SET
          relative_path = excluded.relative_path,
          byte_size = excluded.byte_size,
          last_used_at = excluded.last_used_at
      `).run(
        derivation.id,
        derivation.contentSha256,
        derivation.task,
        derivation.providerConfigId,
        derivation.modelId,
        derivation.promptSha256,
        derivation.transformVersion,
        derivation.language,
        derivation.relativePath,
        derivation.byteSize,
        derivation.now,
        derivation.now,
      );
    })();
  }

  touch(id: string, contentSha256: string, now: number): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE attachment_vision_derivations SET last_used_at = ? WHERE id = ?
      `).run(now, id);
      this.db.prepare(`
        UPDATE attachment_cached_images SET last_used_at = ? WHERE content_sha256 = ?
      `).run(now, contentSha256);
    })();
  }

  listDerivationsBefore(cutoff: number, limit: number): AttachmentVisionDerivationRow[] {
    return this.db.prepare(`
      SELECT *
      FROM attachment_vision_derivations
      WHERE last_used_at < ?
      ORDER BY last_used_at ASC, id ASC
      LIMIT ?
    `).all(cutoff, limit) as AttachmentVisionDerivationRow[];
  }

  listOldestDerivations(limit: number): AttachmentVisionDerivationRow[] {
    return this.db.prepare(`
      SELECT *
      FROM attachment_vision_derivations
      ORDER BY last_used_at ASC, id ASC
      LIMIT ?
    `).all(limit) as AttachmentVisionDerivationRow[];
  }

  deleteDerivation(id: string): void {
    this.db.prepare('DELETE FROM attachment_vision_derivations WHERE id = ?').run(id);
  }

  deleteMissingDerivation(id: string): void {
    this.deleteDerivation(id);
  }

  totalBytes(): number {
    const row = this.db.prepare(`
      SELECT
        COALESCE((SELECT SUM(byte_size) FROM attachment_cached_images), 0)
        + COALESCE((SELECT SUM(byte_size) FROM attachment_vision_derivations), 0)
        AS total
    `).get() as { total: number };
    return row.total;
  }

  findUnreferencedImages(limit: number): CachedAttachmentImageRow[] {
    return this.db.prepare(`
      SELECT image.*
      FROM attachment_cached_images image
      WHERE NOT EXISTS (
        SELECT 1
        FROM attachment_vision_derivations derivation
        WHERE derivation.content_sha256 = image.content_sha256
      )
      ORDER BY image.last_used_at ASC, image.content_sha256 ASC
      LIMIT ?
    `).all(limit) as CachedAttachmentImageRow[];
  }

  deleteImage(contentSha256: string): void {
    this.db.prepare(`
      DELETE FROM attachment_cached_images WHERE content_sha256 = ?
    `).run(contentSha256);
  }
}
