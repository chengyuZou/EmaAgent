import { CharacterVoiceSampleRepo, type CharacterVoiceSampleRow } from '@ema-agent/storage';
import type { CharacterVoiceSample, CharacterVoiceSampleInput, CharacterVoiceSamplePatch } from './types.js';

function fromRow(row: CharacterVoiceSampleRow): CharacterVoiceSample {
  return {
    name: row.name,
    characterName: row.character_name,
    displayName: row.display_name,
    promptText: row.prompt_text,
    promptLang: row.prompt_lang,
    isPrimary: row.is_primary === 1,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterVoiceSampleRepository {
  constructor(private readonly repo: CharacterVoiceSampleRepo) {}

  list(characterName: string): CharacterVoiceSample[] {
    return this.repo.listForCharacter(characterName).map(fromRow);
  }

  find(characterName: string, name: string): CharacterVoiceSample | undefined {
    const row = this.repo.find(characterName, name);
    return row ? fromRow(row) : undefined;
  }

  findPrimary(characterName: string): CharacterVoiceSample | undefined {
    const row = this.repo.findPrimary(characterName);
    return row ? fromRow(row) : undefined;
  }

  listForCharacters(characterNames: readonly string[]): Map<string, CharacterVoiceSample[]> {
    const grouped = new Map<string, CharacterVoiceSample[]>();
    for (const row of this.repo.listForCharacters(characterNames)) {
      const list = grouped.get(row.character_name) ?? [];
      list.push(fromRow(row));
      grouped.set(row.character_name, list);
    }
    return grouped;
  }

  insert(characterName: string, input: CharacterVoiceSampleInput): CharacterVoiceSample {
    const now = Date.now();
    this.repo.insert({ ...input, characterName, createdAt: now, updatedAt: now });
    return fromRow(this.repo.find(characterName, input.name)!);
  }

  setPrimary(characterName: string, name: string): boolean {
    return this.repo.setPrimary(characterName, name, Date.now());
  }

  update(characterName: string, name: string, patch: CharacterVoiceSamplePatch): CharacterVoiceSample | undefined {
    const row = this.repo.update(characterName, name, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  delete(characterName: string, name: string): CharacterVoiceSample | undefined {
    const row = this.repo.delete(characterName, name);
    return row ? fromRow(row) : undefined;
  }
}
