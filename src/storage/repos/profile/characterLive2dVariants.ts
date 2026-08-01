// 持久化角色拥有的 Live2D/VRM 变体及其稳定排序和主项选择。

import type {
  CharacterCardId,
  CharacterLive2dId,
} from '@ema-agent/ids';
import type { SqliteDb } from '../../database/database.js';

export type CharacterLive2dFormat = 'live2d' | 'vrm';

export interface CharacterLive2dVariantRow {
  id: string;
  character_card_id: string;
  label: string;
  format: CharacterLive2dFormat;
  entry_path: string;
  runtime_config_path: string | null;
  position: number;
  is_primary: number;
  enabled: number;
  resource_version: string | null;
  content_sha256: string | null;
  byte_size: number | null;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

export interface CharacterLive2dVariantInsert {
  id: CharacterLive2dId;
  characterCardId: CharacterCardId;
  label: string;
  format: CharacterLive2dFormat;
  entryPath: string;
  runtimeConfigPath?: string | null;
  position?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  resourceVersion?: string | null;
  contentSha256?: string | null;
  byteSize?: number | null;
  isBuiltin?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterLive2dVariantUpdate {
  label?: string;
  position?: number;
  enabled?: boolean;
}

export class CharacterLive2dVariantsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(input: CharacterLive2dVariantInsert): void {
    this.db.transaction(() => {
      if (input.isPrimary) {
        this.clearPrimary(input.characterCardId);
      }
      this.db.prepare(
        `INSERT INTO character_live2d_variants (
           id, character_card_id, label, format, entry_path, runtime_config_path,
           position, is_primary, enabled, resource_version, content_sha256,
           byte_size, is_builtin, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.characterCardId,
        input.label,
        input.format,
        input.entryPath,
        input.runtimeConfigPath ?? null,
        input.position ?? 0,
        input.isPrimary ? 1 : 0,
        input.enabled === false ? 0 : 1,
        input.resourceVersion ?? null,
        input.contentSha256 ?? null,
        input.byteSize ?? null,
        input.isBuiltin ? 1 : 0,
        input.createdAt,
        input.updatedAt,
      );
    })();
  }

  findById(
    characterCardId: CharacterCardId,
    id: CharacterLive2dId,
  ): CharacterLive2dVariantRow | undefined {
    return this.db.prepare(
      `SELECT * FROM character_live2d_variants
       WHERE character_card_id = ? AND id = ?`,
    ).get(characterCardId, id) as CharacterLive2dVariantRow | undefined;
  }

  listForCard(characterCardId: CharacterCardId): CharacterLive2dVariantRow[] {
    return this.db.prepare(
      `SELECT * FROM character_live2d_variants
       WHERE character_card_id = ?
       ORDER BY position ASC, id ASC`,
    ).all(characterCardId) as CharacterLive2dVariantRow[];
  }

  setPrimary(
    characterCardId: CharacterCardId,
    id: CharacterLive2dId,
    updatedAt: number,
  ): boolean {
    return this.db.transaction(() => {
      const target = this.db.prepare(
        `SELECT 1 FROM character_live2d_variants
         WHERE character_card_id = ? AND id = ? AND enabled = 1`,
      ).get(characterCardId, id);
      if (!target) return false;

      this.clearPrimary(characterCardId);
      this.db.prepare(
        `UPDATE character_live2d_variants
         SET is_primary = 1, updated_at = ?
         WHERE character_card_id = ? AND id = ?`,
      ).run(updatedAt, characterCardId, id);
      return true;
    })();
  }

  update(
    characterCardId: CharacterCardId,
    id: CharacterLive2dId,
    patch: CharacterLive2dVariantUpdate,
    updatedAt: number,
  ): CharacterLive2dVariantRow | undefined {
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
        `UPDATE character_live2d_variants
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
    id: CharacterLive2dId,
    updatedAt: number,
  ): CharacterLive2dVariantRow | undefined {
    return this.db.transaction(() => {
      const row = this.findById(characterCardId, id);
      if (!row) return undefined;

      this.db.prepare(
        `DELETE FROM character_live2d_variants
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
      `UPDATE character_live2d_variants
       SET is_primary = 0
       WHERE character_card_id = ? AND is_primary = 1`,
    ).run(characterCardId);
  }

  private promoteFirstEnabled(characterCardId: CharacterCardId, updatedAt: number): void {
    this.db.prepare(
      `UPDATE character_live2d_variants
       SET is_primary = 1, updated_at = ?
       WHERE id = (
         SELECT id FROM character_live2d_variants
         WHERE character_card_id = ? AND enabled = 1
         ORDER BY position ASC, id ASC
         LIMIT 1
       )`,
    ).run(updatedAt, characterCardId);
  }

  private ensurePrimary(characterCardId: CharacterCardId, updatedAt: number): void {
    const primary = this.db.prepare(
      `SELECT 1 FROM character_live2d_variants
       WHERE character_card_id = ? AND enabled = 1 AND is_primary = 1`,
    ).get(characterCardId);
    if (!primary) this.promoteFirstEnabled(characterCardId, updatedAt);
  }
}
