// 持久化角色参考音频及其提示文本和主音频选择。

import type { SqliteDb } from '../../database/database.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';

export interface CharacterVoiceSampleRow {
  id: string;
  character_id: string;
  name: string;
  file_name: string;
  prompt_text: string;
  prompt_lang: string;
  is_primary: number;
  enabled: number;
  mime_type: string;
  byte_size: number | null;
  duration_ms: number | null;
  created_at: number;
  updated_at: number;
}

export interface CharacterVoiceSampleInsert {
  id: string;
  characterId: string;
  name: string;
  /** 创建时确定、此后不可修改的磁盘文件名。 */
  fileName: string;
  promptText: string;
  promptLang: string;
  isPrimary?: boolean;
  enabled?: boolean;
  mimeType: string;
  byteSize?: number | null;
  durationMs?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterVoiceSampleUpdate {
  name?: string;
  enabled?: boolean;
}

export class CharacterVoiceSampleRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(input: CharacterVoiceSampleInsert): void {
    this.db.transaction(() => {
      if (input.isPrimary) {
        this.clearPrimary(input.characterId);
      }
      this.db.prepare(
        `INSERT INTO character_voice_samples (
           id, character_id, name, file_name, prompt_text,
           prompt_lang, is_primary, enabled, mime_type,
           byte_size, duration_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.characterId,
        input.name,
        input.fileName,
        input.promptText,
        input.promptLang,
        input.isPrimary ? 1 : 0,
        input.enabled === false ? 0 : 1,
        input.mimeType,
        input.byteSize ?? null,
        input.durationMs ?? null,
        input.createdAt,
        input.updatedAt,
      );
    })();
  }

  findById(
    characterId: string,
    id: string,
  ): CharacterVoiceSampleRow | undefined {
    return this.db.prepare(
      `SELECT * FROM character_voice_samples
       WHERE character_id = ? AND id = ?`,
    ).get(characterId, id) as CharacterVoiceSampleRow | undefined;
  }

  listForCharacter(characterId: string): CharacterVoiceSampleRow[] {
    return this.db.prepare(
      `SELECT * FROM character_voice_samples
       WHERE character_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(characterId) as CharacterVoiceSampleRow[];
  }

  /** 批量取多张角色的资源,替代逐角色 listForCharacter 的 N+1 查询。 */
  listForCharacters(characterIds: readonly string[]): CharacterVoiceSampleRow[] {
    const rows: CharacterVoiceSampleRow[] = [];
    for (const batch of createSqliteIdBatches(this.db, characterIds)) {
      rows.push(...this.db.prepare(
        `SELECT * FROM character_voice_samples
         WHERE character_id IN (${batch.map(() => '?').join(', ')})
         ORDER BY character_id ASC, created_at ASC, id ASC`,
      ).all(...batch) as CharacterVoiceSampleRow[]);
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
        `SELECT 1 FROM character_voice_samples
         WHERE character_id = ? AND id = ? AND enabled = 1`,
      ).get(characterId, id);
      if (!target) return false;

      this.clearPrimary(characterId);
      this.db.prepare(
        `UPDATE character_voice_samples
         SET is_primary = 1, updated_at = ?
         WHERE character_id = ? AND id = ?`,
      ).run(updatedAt, characterId, id);
      return true;
    })();
  }

  update(
    characterId: string,
    id: string,
    patch: CharacterVoiceSampleUpdate,
    updatedAt: number,
  ): CharacterVoiceSampleRow | undefined {
    return this.db.transaction(() => {
      const current = this.findById(characterId, id);
      if (!current) return undefined;

      const name = patch.name ?? current.name;
      const enabled = patch.enabled ?? current.enabled === 1;
      const changed = name !== current.name
        || enabled !== (current.enabled === 1);
      if (!changed) return current;
      const revisionAt = Math.max(updatedAt, current.updated_at + 1);

      this.db.prepare(
        `UPDATE character_voice_samples
         SET name = ?, enabled = ?,
             is_primary = CASE WHEN ? = 1 THEN is_primary ELSE 0 END,
             updated_at = ?
         WHERE character_id = ? AND id = ?`,
      ).run(
        name,
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
  ): CharacterVoiceSampleRow | undefined {
    return this.db.transaction(() => {
      const row = this.findById(characterId, id);
      if (!row) return undefined;

      this.db.prepare(
        `DELETE FROM character_voice_samples
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
      `UPDATE character_voice_samples
       SET is_primary = 0
       WHERE character_id = ? AND is_primary = 1`,
    ).run(characterId);
  }

  private promoteFirstEnabled(characterId: string, updatedAt: number): void {
    this.db.prepare(
      `UPDATE character_voice_samples
       SET is_primary = 1, updated_at = ?
       WHERE id = (
         SELECT id FROM character_voice_samples
         WHERE character_id = ? AND enabled = 1
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )`,
    ).run(updatedAt, characterId);
  }

  private ensurePrimary(characterId: string, updatedAt: number): void {
    const primary = this.db.prepare(
      `SELECT 1 FROM character_voice_samples
       WHERE character_id = ? AND enabled = 1 AND is_primary = 1`,
    ).get(characterId);
    if (!primary) this.promoteFirstEnabled(characterId, updatedAt);
  }
}
