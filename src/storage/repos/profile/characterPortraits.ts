// 持久化角色立绘的尺寸、格式、稳定排序和主图选择。

import type {
  CharacterCardId,
  CharacterPortraitId,
} from '@ema-agent/ids';
import type { SqliteDb } from '../../database/database.js';

export type CharacterPortraitMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface CharacterPortraitRow {
  id: string;
  character_card_id: string;
  label: string;
  relative_path: string;
  position: number;
  is_primary: number;
  enabled: number;
  mime_type: CharacterPortraitMime;
  byte_size: number;
  width: number;
  height: number;
  content_sha256: string | null;
  created_at: number;
  updated_at: number;
}

export interface CharacterPortraitInsert {
  id: CharacterPortraitId;
  characterCardId: CharacterCardId;
  label: string;
  relativePath: string;
  position?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  mimeType: CharacterPortraitMime;
  byteSize: number;
  width: number;
  height: number;
  contentSha256?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterPortraitUpdate {
  label?: string;
  position?: number;
  enabled?: boolean;
}

export class CharacterPortraitsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(input: CharacterPortraitInsert): void {
    this.db.transaction(() => {
      if (input.isPrimary) {
        this.clearPrimary(input.characterCardId);
      }
      this.db.prepare(
        `INSERT INTO character_portraits (
           id, character_card_id, label, relative_path, position,
           is_primary, enabled, mime_type, byte_size, width, height,
           content_sha256, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.characterCardId,
        input.label,
        input.relativePath,
        input.position ?? 0,
        input.isPrimary ? 1 : 0,
        input.enabled === false ? 0 : 1,
        input.mimeType,
        input.byteSize,
        input.width,
        input.height,
        input.contentSha256 ?? null,
        input.createdAt,
        input.updatedAt,
      );
    })();
  }

  findById(
    characterCardId: CharacterCardId,
    id: CharacterPortraitId,
  ): CharacterPortraitRow | undefined {
    return this.db.prepare(
      `SELECT * FROM character_portraits
       WHERE character_card_id = ? AND id = ?`,
    ).get(characterCardId, id) as CharacterPortraitRow | undefined;
  }

  listForCard(characterCardId: CharacterCardId): CharacterPortraitRow[] {
    return this.db.prepare(
      `SELECT * FROM character_portraits
       WHERE character_card_id = ?
       ORDER BY position ASC, id ASC`,
    ).all(characterCardId) as CharacterPortraitRow[];
  }

  setPrimary(
    characterCardId: CharacterCardId,
    id: CharacterPortraitId,
    updatedAt: number,
  ): boolean {
    return this.db.transaction(() => {
      const target = this.db.prepare(
        `SELECT 1 FROM character_portraits
         WHERE character_card_id = ? AND id = ? AND enabled = 1`,
      ).get(characterCardId, id);
      if (!target) return false;

      this.clearPrimary(characterCardId);
      this.db.prepare(
        `UPDATE character_portraits
         SET is_primary = 1, updated_at = ?
         WHERE character_card_id = ? AND id = ?`,
      ).run(updatedAt, characterCardId, id);
      return true;
    })();
  }

  update(
    characterCardId: CharacterCardId,
    id: CharacterPortraitId,
    patch: CharacterPortraitUpdate,
    updatedAt: number,
  ): CharacterPortraitRow | undefined {
    return this.db.transaction(() => {
      const current = this.findById(characterCardId, id);
      if (!current) return undefined;

      const label = patch.label ?? current.label;
      const position = patch.position ?? current.position;
      const enabled = patch.enabled ?? current.enabled === 1;
      const changed = label !== current.label
        || position !== current.position
        || enabled !== (current.enabled === 1);
      if (!changed) return current;
      const revisionAt = Math.max(updatedAt, current.updated_at + 1);

      this.db.prepare(
        `UPDATE character_portraits
         SET label = ?, position = ?, enabled = ?,
             is_primary = CASE WHEN ? = 1 THEN is_primary ELSE 0 END,
             updated_at = ?
         WHERE character_card_id = ? AND id = ?`,
      ).run(
        label,
        position,
        enabled ? 1 : 0,
        enabled ? 1 : 0,
        revisionAt,
        characterCardId,
        id,
      );
      this.ensurePrimary(characterCardId, revisionAt);
      return this.findById(characterCardId, id);
    })();
  }

  delete(
    characterCardId: CharacterCardId,
    id: CharacterPortraitId,
    updatedAt: number,
  ): CharacterPortraitRow | undefined {
    return this.db.transaction(() => {
      const row = this.findById(characterCardId, id);
      if (!row) return undefined;

      this.db.prepare(
        `DELETE FROM character_portraits
         WHERE character_card_id = ? AND id = ?`,
      ).run(characterCardId, id);
      if (row.is_primary === 1) {
        this.promoteFirstEnabled(characterCardId, updatedAt);
      }
      return row;
    })();
  }

  private clearPrimary(characterCardId: CharacterCardId): void {
    this.db.prepare(
      `UPDATE character_portraits
       SET is_primary = 0
       WHERE character_card_id = ? AND is_primary = 1`,
    ).run(characterCardId);
  }

  private promoteFirstEnabled(characterCardId: CharacterCardId, updatedAt: number): void {
    this.db.prepare(
      `UPDATE character_portraits
       SET is_primary = 1, updated_at = ?
       WHERE id = (
         SELECT id FROM character_portraits
         WHERE character_card_id = ? AND enabled = 1
         ORDER BY position ASC, id ASC
         LIMIT 1
       )`,
    ).run(updatedAt, characterCardId);
  }

  private ensurePrimary(characterCardId: CharacterCardId, updatedAt: number): void {
    const primary = this.db.prepare(
      `SELECT 1 FROM character_portraits
       WHERE character_card_id = ? AND enabled = 1 AND is_primary = 1`,
    ).get(characterCardId);
    if (!primary) this.promoteFirstEnabled(characterCardId, updatedAt);
  }
}
