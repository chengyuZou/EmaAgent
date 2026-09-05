import type { SqliteDb } from '../../database/database.js';
import { createSqliteIdBatches } from '../../database/sqlite-id-batches.js';

export interface CharacterVoiceSampleRow {
  name: string;
  character_name: string;
  display_name: string;
  prompt_text: string;
  prompt_lang: string;
  is_primary: number;
  mime_type: string;
  byte_size: number | null;
  duration_ms: number | null;
  created_at: number;
  updated_at: number;
}

export interface CharacterVoiceSampleInsert {
  name: string;
  characterName: string;
  displayName: string;
  promptText: string;
  promptLang: string;
  isPrimary?: boolean;
  mimeType: string;
  byteSize?: number | null;
  durationMs?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterVoiceSampleUpdate {
  displayName?: string;
}

export class CharacterVoiceSampleRepo {
  constructor(private readonly db: SqliteDb) {}
  insert(input: CharacterVoiceSampleInsert): void {
    this.db.transaction(() => {
      if (input.isPrimary) this.clearPrimary(input.characterName, input.updatedAt);
      this.db.prepare(
        `INSERT INTO character_voice_samples
         (name, character_name, display_name, prompt_text, prompt_lang, is_primary, mime_type,
          byte_size, duration_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.name,
        input.characterName,
        input.displayName,
        input.promptText,
        input.promptLang,
        input.isPrimary ? 1 : 0,
        input.mimeType,
        input.byteSize ?? null,
        input.durationMs ?? null,
        input.createdAt,
        input.updatedAt,
      );
    })();
  }

  find(characterName: string, name: string): CharacterVoiceSampleRow | undefined {
    return this.db.prepare(
      'SELECT * FROM character_voice_samples WHERE character_name = ? AND name = ?',
    ).get(characterName, name) as CharacterVoiceSampleRow | undefined;
  }

  findPrimary(characterName: string): CharacterVoiceSampleRow | undefined {
    return this.db.prepare(
      'SELECT * FROM character_voice_samples WHERE character_name = ? AND is_primary = 1',
    ).get(characterName) as CharacterVoiceSampleRow | undefined;
  }

  listForCharacter(characterName: string): CharacterVoiceSampleRow[] {
    return this.db.prepare(
      'SELECT * FROM character_voice_samples WHERE character_name = ? ORDER BY created_at, name',
    ).all(characterName) as CharacterVoiceSampleRow[];
  }
  listForCharacters(characterNames: readonly string[]): CharacterVoiceSampleRow[] {
    const rows: CharacterVoiceSampleRow[] = [];
    for (const batch of createSqliteIdBatches(this.db, characterNames)) {
      rows.push(
        ...this.db.prepare(
          `SELECT * FROM character_voice_samples WHERE character_name IN (${batch.map(() => '?').join(', ')}) ORDER BY character_name, created_at, name`,
        ).all(...batch) as CharacterVoiceSampleRow[],
      );
    }
    return rows;
  }

  setPrimary(characterName: string, name: string, updatedAt: number): boolean {
    return this.db.transaction(() => {
      if (!this.find(characterName, name)) return false;
      this.clearPrimary(characterName, updatedAt);
      this.db.prepare(
        'UPDATE character_voice_samples SET is_primary = 1, updated_at = ? WHERE character_name = ? AND name = ?',
      ).run(updatedAt, characterName, name);
      return true;
    })();
  }
  update(characterName: string, name: string, patch: CharacterVoiceSampleUpdate, updatedAt: number): CharacterVoiceSampleRow | undefined {
    if (patch.displayName !== undefined) {
      this.db.prepare(
        'UPDATE character_voice_samples SET display_name = ?, updated_at = ? WHERE character_name = ? AND name = ?',
      ).run(patch.displayName, updatedAt, characterName, name);
    }
    return this.find(characterName, name);
  }

  delete(characterName: string, name: string): CharacterVoiceSampleRow | undefined {
    const row = this.find(characterName, name);
    if (row) {
      this.db.prepare('DELETE FROM character_voice_samples WHERE character_name = ? AND name = ?').run(characterName, name);
    }
    return row;
  }

  private clearPrimary(characterName: string, updatedAt: number): void {
    this.db.prepare(
      'UPDATE character_voice_samples SET is_primary = 0, updated_at = ? WHERE character_name = ? AND is_primary = 1',
    ).run(updatedAt, characterName);
  }
}
