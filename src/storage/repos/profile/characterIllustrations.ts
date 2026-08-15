// 持久化角色立绘的展示名称、舞台位置和主图选择。

import type { SqliteDb } from '../../database/database.js';

export interface CharacterIllustrationRow {
  id: string;
  character_card_id: string;
  name: string;
  stage_scale: number;
  stage_offset_x: number;
  stage_offset_y: number;
  is_primary: number;
  enabled: number;
  byte_size: number;
  created_at: number;
  updated_at: number;
}

export interface CharacterIllustrationInsert {
  id: string;
  characterCardId: string;
  name: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  byteSize: number;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterIllustrationUpdate {
  name?: string;
  stageScale?: number;
  stageOffsetX?: number;
  stageOffsetY?: number;
  enabled?: boolean;
}

export class CharacterIllustrationsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(input: CharacterIllustrationInsert): void {
    this.db.transaction(() => {
      if (input.isPrimary) {
        this.clearPrimary(input.characterCardId);
      }
      this.db.prepare(
        `INSERT INTO character_illustrations (
           id, character_card_id, name, stage_scale,
           stage_offset_x, stage_offset_y, is_primary, enabled, byte_size,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.characterCardId,
        input.name,
        input.stageScale ?? 1,
        input.stageOffsetX ?? 0,
        input.stageOffsetY ?? 0,
        input.isPrimary ? 1 : 0,
        input.enabled === false ? 0 : 1,
        input.byteSize,
        input.createdAt,
        input.updatedAt,
      );
    })();
  }

  findById(
    characterCardId: string,
    id: string,
  ): CharacterIllustrationRow | undefined {
    return this.db.prepare(
      `SELECT * FROM character_illustrations
       WHERE character_card_id = ? AND id = ?`,
    ).get(characterCardId, id) as CharacterIllustrationRow | undefined;
  }

  listForCard(characterCardId: string): CharacterIllustrationRow[] {
    return this.db.prepare(
      `SELECT * FROM character_illustrations
       WHERE character_card_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(characterCardId) as CharacterIllustrationRow[];
  }

  /** 批量取多张卡的资源,替代逐卡 listForCard 的 N+1 查询。 */
  listForCards(characterCardIds: readonly string[]): CharacterIllustrationRow[] {
    if (characterCardIds.length === 0) return [];
    const placeholders = characterCardIds.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT * FROM character_illustrations
       WHERE character_card_id IN (${placeholders})
       ORDER BY character_card_id ASC, created_at ASC, id ASC`,
    ).all(...characterCardIds) as CharacterIllustrationRow[];
  }

  setPrimary(
    characterCardId: string,
    id: string,
    updatedAt: number,
  ): boolean {
    return this.db.transaction(() => {
      const target = this.db.prepare(
        `SELECT 1 FROM character_illustrations
         WHERE character_card_id = ? AND id = ? AND enabled = 1`,
      ).get(characterCardId, id);
      if (!target) return false;

      this.clearPrimary(characterCardId);
      this.db.prepare(
        `UPDATE character_illustrations
         SET is_primary = 1, updated_at = ?
         WHERE character_card_id = ? AND id = ?`,
      ).run(updatedAt, characterCardId, id);
      return true;
    })();
  }

  update(
    characterCardId: string,
    id: string,
    patch: CharacterIllustrationUpdate,
    updatedAt: number,
  ): CharacterIllustrationRow | undefined {
    return this.db.transaction(() => {
      const current = this.findById(characterCardId, id);
      if (!current) return undefined;

      const name = patch.name ?? current.name;
      const stageScale = patch.stageScale ?? current.stage_scale;
      const stageOffsetX = patch.stageOffsetX ?? current.stage_offset_x;
      const stageOffsetY = patch.stageOffsetY ?? current.stage_offset_y;
      const enabled = patch.enabled ?? current.enabled === 1;
      const changed = name !== current.name
        || stageScale !== current.stage_scale
        || stageOffsetX !== current.stage_offset_x
        || stageOffsetY !== current.stage_offset_y
        || enabled !== (current.enabled === 1);
      if (!changed) return current;
      const revisionAt = Math.max(updatedAt, current.updated_at + 1);

      this.db.prepare(
        `UPDATE character_illustrations
         SET name = ?, stage_scale = ?, stage_offset_x = ?, stage_offset_y = ?, enabled = ?,
             is_primary = CASE WHEN ? = 1 THEN is_primary ELSE 0 END,
             updated_at = ?
         WHERE character_card_id = ? AND id = ?`,
      ).run(
        name,
        stageScale,
        stageOffsetX,
        stageOffsetY,
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
    characterCardId: string,
    id: string,
    updatedAt: number,
  ): CharacterIllustrationRow | undefined {
    return this.db.transaction(() => {
      const row = this.findById(characterCardId, id);
      if (!row) return undefined;

      this.db.prepare(
        `DELETE FROM character_illustrations
         WHERE character_card_id = ? AND id = ?`,
      ).run(characterCardId, id);
      if (row.is_primary === 1) {
        this.promoteFirstEnabled(characterCardId, updatedAt);
      }
      return row;
    })();
  }

  private clearPrimary(characterCardId: string): void {
    this.db.prepare(
      `UPDATE character_illustrations
       SET is_primary = 0
       WHERE character_card_id = ? AND is_primary = 1`,
    ).run(characterCardId);
  }

  private promoteFirstEnabled(characterCardId: string, updatedAt: number): void {
    this.db.prepare(
      `UPDATE character_illustrations
       SET is_primary = 1, updated_at = ?
       WHERE id = (
         SELECT id FROM character_illustrations
         WHERE character_card_id = ? AND enabled = 1
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )`,
    ).run(updatedAt, characterCardId);
  }

  private ensurePrimary(characterCardId: string, updatedAt: number): void {
    const primary = this.db.prepare(
      `SELECT 1 FROM character_illustrations
       WHERE character_card_id = ? AND enabled = 1 AND is_primary = 1`,
    ).get(characterCardId);
    if (!primary) this.promoteFirstEnabled(characterCardId, updatedAt);
  }
}
