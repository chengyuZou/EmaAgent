import { CharacterIllustrationRepo, type CharacterIllustrationRow } from '@ema-agent/storage';
import type { CharacterIllustration, CharacterIllustrationInput, CharacterIllustrationPatch } from './types.js';

function fromRow(row: CharacterIllustrationRow): CharacterIllustration {
  return {
    name: row.name,
    characterName: row.character_name,
    displayName: row.display_name,
    expression: row.expression,
    stageScale: row.stage_scale,
    stageOffsetX: row.stage_offset_x,
    stageOffsetY: row.stage_offset_y,
    isPrimary: row.is_primary === 1,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterIllustrationRepository {
  constructor(private readonly repo: CharacterIllustrationRepo) {}

  list(characterName: string): CharacterIllustration[] {
    return this.repo.listForCharacter(characterName).map(fromRow);
  }

  find(characterName: string, name: string): CharacterIllustration | undefined {
    const row = this.repo.find(characterName, name);
    return row ? fromRow(row) : undefined;
  }

  findPrimary(characterName: string): CharacterIllustration | undefined {
    const row = this.repo.findPrimary(characterName);
    return row ? fromRow(row) : undefined;
  }

  listForCharacters(characterNames: readonly string[]): Map<string, CharacterIllustration[]> {
    const grouped = new Map<string, CharacterIllustration[]>();
    for (const row of this.repo.listForCharacters(characterNames)) {
      const list = grouped.get(row.character_name) ?? [];
      list.push(fromRow(row));
      grouped.set(row.character_name, list);
    }
    return grouped;
  }

  insert(characterName: string, input: CharacterIllustrationInput): CharacterIllustration {
    const now = Date.now();
    this.repo.insert({ ...input, characterName, createdAt: now, updatedAt: now });
    return fromRow(this.repo.find(characterName, input.name)!);
  }

  setPrimary(characterName: string, name: string): boolean {
    return this.repo.setPrimary(characterName, name, Date.now());
  }

  update(characterName: string, name: string, patch: CharacterIllustrationPatch): CharacterIllustration | undefined {
    const row = this.repo.update(characterName, name, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  delete(characterName: string, name: string): CharacterIllustration | undefined {
    const row = this.repo.delete(characterName, name);
    return row ? fromRow(row) : undefined;
  }
}
