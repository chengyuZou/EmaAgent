// 持久化角色拥有的 Live2D 资源、舞台位置、主项选择与派生控制词汇。

import type { SqliteDb } from '../../database/database.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';

export interface CharacterLive2dModelRow {
  id: string;
  character_id: string;
  name: string;
  directory_name: string;
  emotion_vocab_json: string;
  motion_vocab_json: string;
  /** 主窗口缩放倍率；1 为模型默认大小，持久化范围为 0.1～5。 */
  stage_scale: number;
  /** 相对舞台中心的水平偏移；-1 为最左侧，0 为居中，1 为最右侧。 */
  stage_offset_x: number;
  /** 相对舞台中心的垂直偏移；-1 为最上方，0 为居中，1 为最下方。 */
  stage_offset_y: number;
  is_primary: number;
  enabled: number;
  byte_size: number | null;
  created_at: number;
  updated_at: number;
}

export interface CharacterLive2dModelInsert {
  id: string;
  characterId: string;
  name: string;
  /** 创建时确定、此后不可修改的磁盘目录名。 */
  directoryName: string;
  /** 主窗口缩放倍率；不传时写入 1。 */
  stageScale?: number;
  /** 相对舞台中心的水平偏移；有效范围为 -1～1。 */
  stageOffsetX?: number;
  /** 相对舞台中心的垂直偏移；有效范围为 -1～1。 */
  stageOffsetY?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  byteSize?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterLive2dModelUpdate {
  name?: string;
  /** 主窗口缩放倍率；有效范围为 0.1～5。 */
  stageScale?: number;
  /** 相对舞台中心的水平偏移；有效范围为 -1～1。 */
  stageOffsetX?: number;
  /** 相对舞台中心的垂直偏移；有效范围为 -1～1。 */
  stageOffsetY?: number;
  enabled?: boolean;
}

export class CharacterLive2dModelRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(input: CharacterLive2dModelInsert): void {
    this.db.transaction(() => {
      if (input.isPrimary) {
        this.clearPrimary(input.characterId);
      }
      this.db.prepare(
        `INSERT INTO character_live2d_models (
           id, character_id, name, directory_name,
           emotion_vocab_json, motion_vocab_json, stage_scale,
           stage_offset_x, stage_offset_y, is_primary, enabled,
           byte_size, created_at, updated_at
         ) VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.characterId,
        input.name,
        input.directoryName,
        input.stageScale ?? 1,
        input.stageOffsetX ?? 0,
        input.stageOffsetY ?? 0,
        input.isPrimary ? 1 : 0,
        input.enabled === false ? 0 : 1,
        input.byteSize ?? null,
        input.createdAt,
        input.updatedAt,
      );
    })();
  }

  findById(
    characterId: string,
    id: string,
  ): CharacterLive2dModelRow | undefined {
    return this.db.prepare(
      `SELECT * FROM character_live2d_models
       WHERE character_id = ? AND id = ?`,
    ).get(characterId, id) as CharacterLive2dModelRow | undefined;
  }

  listForCharacter(characterId: string): CharacterLive2dModelRow[] {
    return this.db.prepare(
      `SELECT * FROM character_live2d_models
       WHERE character_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(characterId) as CharacterLive2dModelRow[];
  }

  /** 批量取多张角色的资源,替代逐角色 listForCharacter 的 N+1 查询。 */
  listForCharacters(characterIds: readonly string[]): CharacterLive2dModelRow[] {
    const rows: CharacterLive2dModelRow[] = [];
    for (const batch of createSqliteIdBatches(this.db, characterIds)) {
      rows.push(...this.db.prepare(
        `SELECT * FROM character_live2d_models
         WHERE character_id IN (${batch.map(() => '?').join(', ')})
         ORDER BY character_id ASC, created_at ASC, id ASC`,
      ).all(...batch) as CharacterLive2dModelRow[]);
    }
    return rows;
  }

  setPrimary(
    characterId: string,
    id: string,
    updatedAt: number,
  ): boolean {
    return this.db.transaction(() => {
      const target = this.db.prepare(
        `SELECT 1 FROM character_live2d_models
         WHERE character_id = ? AND id = ? AND enabled = 1`,
      ).get(characterId, id);
      if (!target) return false;

      this.clearPrimary(characterId);
      this.db.prepare(
        `UPDATE character_live2d_models
         SET is_primary = 1, updated_at = ?
         WHERE character_id = ? AND id = ?`,
      ).run(updatedAt, characterId, id);
      return true;
    })();
  }

  /** 仅供主用 Live2D 词汇提取流程写入派生词汇，普通资源编辑不能修改这两列。 */
  updateVocabularies(
    characterId: string,
    id: string,
    emotionVocabulary: readonly string[],
    motionVocabulary: readonly string[],
    updatedAt: number,
  ): CharacterLive2dModelRow | undefined {
    const current = this.findById(characterId, id);
    if (!current) return undefined;

    this.db.prepare(
      `UPDATE character_live2d_models
       SET emotion_vocab_json = ?, motion_vocab_json = ?, updated_at = ?
       WHERE character_id = ? AND id = ?`,
    ).run(
      JSON.stringify(emotionVocabulary),
      JSON.stringify(motionVocabulary),
      Math.max(updatedAt, current.updated_at + 1),
      characterId,
      id,
    );
    return this.findById(characterId, id);
  }

  update(
    characterId: string,
    id: string,
    patch: CharacterLive2dModelUpdate,
    updatedAt: number,
  ): CharacterLive2dModelRow | undefined {
    return this.db.transaction(() => {
      const current = this.findById(characterId, id);
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
        `UPDATE character_live2d_models
         SET name = ?, stage_scale = ?, stage_offset_x = ?, stage_offset_y = ?, enabled = ?,
             is_primary = CASE WHEN ? = 1 THEN is_primary ELSE 0 END,
             updated_at = ?
         WHERE character_id = ? AND id = ?`,
      ).run(
        name,
        stageScale,
        stageOffsetX,
        stageOffsetY,
        enabled ? 1 : 0,
        enabled ? 1 : 0,
        revisionAt,
        characterId,
        id,
      );
      this.ensurePrimary(characterId, revisionAt);
      return this.findById(characterId, id);
    })();
  }

  delete(
    characterId: string,
    id: string,
    updatedAt: number,
  ): CharacterLive2dModelRow | undefined {
    return this.db.transaction(() => {
      const row = this.findById(characterId, id);
      if (!row) return undefined;

      this.db.prepare(
        `DELETE FROM character_live2d_models
         WHERE character_id = ? AND id = ?`,
      ).run(characterId, id);

      if (row.is_primary === 1) {
        this.promoteFirstEnabled(characterId, updatedAt);
      }
      return row;
    })();
  }

  private clearPrimary(characterId: string): void {
    this.db.prepare(
      `UPDATE character_live2d_models
       SET is_primary = 0
       WHERE character_id = ? AND is_primary = 1`,
    ).run(characterId);
  }

  private promoteFirstEnabled(characterId: string, updatedAt: number): void {
    this.db.prepare(
      `UPDATE character_live2d_models
       SET is_primary = 1, updated_at = ?
       WHERE id = (
         SELECT id FROM character_live2d_models
         WHERE character_id = ? AND enabled = 1
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )`,
    ).run(updatedAt, characterId);
  }

  private ensurePrimary(characterId: string, updatedAt: number): void {
    const primary = this.db.prepare(
      `SELECT 1 FROM character_live2d_models
       WHERE character_id = ? AND enabled = 1 AND is_primary = 1`,
    ).get(characterId);
    if (!primary) this.promoteFirstEnabled(characterId, updatedAt);
  }
}
