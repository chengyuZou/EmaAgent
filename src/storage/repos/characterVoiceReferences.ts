// 持久化角色参考音频及其提示文本、稳定排序和主音频选择。

import type {
  CharacterCardId,
  CharacterVoiceReferenceId,
} from '@ema-agent/ids';
import type { SqliteDb } from '../database.js';

export interface CharacterVoiceReferenceRow {
  id: string;
  character_card_id: string;
  label: string;
  relative_path: string;
  prompt_text: string;
  prompt_lang: string;
  position: number;
  is_primary: number;
  enabled: number;
  mime_type: string;
  byte_size: number | null;
  duration_ms: number | null;
  content_sha256: string | null;
  created_at: number;
  updated_at: number;
}

export interface CharacterVoiceReferenceInsert {
  id: CharacterVoiceReferenceId;
  characterCardId: CharacterCardId;
  label: string;
  relativePath: string;
  promptText: string;
  promptLang: string;
  position?: number;
  isPrimary?: boolean;
  enabled?: boolean;
  mimeType: string;
  byteSize?: number | null;
  durationMs?: number | null;
  contentSha256?: string | null;
  createdAt: number;
  updatedAt: number;
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
           id, character_card_id, label, relative_path, prompt_text,
           prompt_lang, position, is_primary, enabled, mime_type,
           byte_size, duration_ms, content_sha256, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.characterCardId,
        input.label,
        input.relativePath,
        input.promptText,
        input.promptLang,
        input.position ?? 0,
        input.isPrimary ? 1 : 0,
        input.enabled === false ? 0 : 1,
        input.mimeType,
        input.byteSize ?? null,
        input.durationMs ?? null,
        input.contentSha256 ?? null,
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
       ORDER BY position ASC, id ASC`,
    ).all(characterCardId) as CharacterVoiceReferenceRow[];
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
         ORDER BY position ASC, id ASC
         LIMIT 1
       )`,
    ).run(updatedAt, characterCardId);
  }
}
