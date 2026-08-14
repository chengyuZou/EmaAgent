// 持久化角色参考音频及其提示文本和主音频选择。

import type {
  CharacterCardId,
  CharacterVoiceReferenceId,
} from '@ema-agent/ids';
import type { SqliteDb } from '../../database/database.js';

export interface CharacterVoiceReferenceRow {
  id: string;
  character_card_id: string;
  name: string;
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

export interface CharacterVoiceReferenceInsert {
  id: CharacterVoiceReferenceId;
  characterCardId: CharacterCardId;
  name: string;
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

export interface CharacterVoiceReferenceUpdate {
  name?: string;
  enabled?: boolean;
}

export class CharacterVoiceReferencesRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(input: CharacterVoiceReferenceInsert): void {
    this.db.transaction(() => {
      if (input.isPrimary) {
        this.clearPrimary(input.characterCardId);
      }
      this.db.prepare(
        `INSERT INTO character_voice_references (
           id, character_card_id, name, prompt_text,
           prompt_lang, is_primary, enabled, mime_type,
           byte_size, duration_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.characterCardId,
        input.name,
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
    characterCardId: CharacterCardId,
    id: CharacterVoiceReferenceId,
  ): CharacterVoiceReferenceRow | undefined {
    return this.db.prepare(
      `SELECT * FROM character_voice_references
       WHERE character_card_id = ? AND id = ?`,
    ).get(characterCardId, id) as CharacterVoiceReferenceRow | undefined;
  }

  listForCard(characterCardId: CharacterCardId): CharacterVoiceReferenceRow[] {
    return this.db.prepare(
      `SELECT * FROM character_voice_references
       WHERE character_card_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(characterCardId) as CharacterVoiceReferenceRow[];
  }

  /** 批量取多张卡的资源,替代逐卡 listForCard 的 N+1 查询。 */
  listForCards(characterCardIds: readonly CharacterCardId[]): CharacterVoiceReferenceRow[] {
    if (characterCardIds.length === 0) return [];
    const placeholders = characterCardIds.map(() => '?').join(', ');
    return this.db.prepare(
      `SELECT * FROM character_voice_references
       WHERE character_card_id IN (${placeholders})
       ORDER BY character_card_id ASC, created_at ASC, id ASC`,
    ).all(...characterCardIds) as CharacterVoiceReferenceRow[];
  }

  setPrimary(
    characterCardId: CharacterCardId,
    id: CharacterVoiceReferenceId,
    updatedAt: number,
  ): boolean {
    return this.db.transaction(() => {
      const target = this.db.prepare(
        `SELECT 1 FROM character_voice_references
         WHERE character_card_id = ? AND id = ? AND enabled = 1`,
      ).get(characterCardId, id);
      if (!target) return false;

      this.clearPrimary(characterCardId);
      this.db.prepare(
        `UPDATE character_voice_references
         SET is_primary = 1, updated_at = ?
         WHERE character_card_id = ? AND id = ?`,
      ).run(updatedAt, characterCardId, id);
      return true;
    })();
  }

  update(
    characterCardId: CharacterCardId,
    id: CharacterVoiceReferenceId,
    patch: CharacterVoiceReferenceUpdate,
    updatedAt: number,
  ): CharacterVoiceReferenceRow | undefined {
    return this.db.transaction(() => {
      const current = this.findById(characterCardId, id);
      if (!current) return undefined;

      const name = patch.name ?? current.name;
      const enabled = patch.enabled ?? current.enabled === 1;
      const changed = name !== current.name
        || enabled !== (current.enabled === 1);
      if (!changed) return current;
      const revisionAt = Math.max(updatedAt, current.updated_at + 1);

      this.db.prepare(
        `UPDATE character_voice_references
         SET name = ?, enabled = ?,
             is_primary = CASE WHEN ? = 1 THEN is_primary ELSE 0 END,
             updated_at = ?
         WHERE character_card_id = ? AND id = ?`,
      ).run(
        name,
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
    id: CharacterVoiceReferenceId,
    updatedAt: number,
  ): CharacterVoiceReferenceRow | undefined {
    return this.db.transaction(() => {
      const row = this.findById(characterCardId, id);
      if (!row) return undefined;

      this.db.prepare(
        `DELETE FROM character_voice_references
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
      `UPDATE character_voice_references
       SET is_primary = 0
       WHERE character_card_id = ? AND is_primary = 1`,
    ).run(characterCardId);
  }

  private promoteFirstEnabled(characterCardId: CharacterCardId, updatedAt: number): void {
    this.db.prepare(
      `UPDATE character_voice_references
       SET is_primary = 1, updated_at = ?
       WHERE id = (
         SELECT id FROM character_voice_references
         WHERE character_card_id = ? AND enabled = 1
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )`,
    ).run(updatedAt, characterCardId);
  }

  private ensurePrimary(characterCardId: CharacterCardId, updatedAt: number): void {
    const primary = this.db.prepare(
      `SELECT 1 FROM character_voice_references
       WHERE character_card_id = ? AND enabled = 1 AND is_primary = 1`,
    ).get(characterCardId);
    if (!primary) this.promoteFirstEnabled(characterCardId, updatedAt);
  }
}
