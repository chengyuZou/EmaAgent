import { CharacterRepo, type CharacterDeleteResult, type CharacterRow } from '@ema-agent/storage';
import type { Character, CharacterInput, CharacterPatch } from './types.js';

function fromRow(row: CharacterRow): Character {
  return {
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    personaPrompt: row.persona_prompt,
    stageKind: row.stage_kind,
    live2dModels: [],
    illustrations: [],
    voiceSamples: [],
    isActive: row.is_active === 1,
    lastActivatedAt: row.last_activated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterRepository {
  constructor(private readonly characters: CharacterRepo) {}

  findByName(name: string): Character | undefined {
    const row = this.characters.findByName(name);
    return row ? fromRow(row) : undefined;
  }

  findActive(): Character | undefined {
    const row = this.characters.findActive();
    return row ? fromRow(row) : undefined;
  }

  list(): Character[] {
    return this.characters.list().map(fromRow);
  }

  insert(input: CharacterInput, stageKind: Character['stageKind'] = 'blank', isActive = false): Character {
    const now = Date.now();
    this.characters.insert({
      ...input,
      stageKind,
      isActive,
      lastActivatedAt: isActive ? now : null,
      createdAt: now,
      updatedAt: now,
    });
    return this.findByName(input.name)!;
  }

  update(name: string, patch: CharacterPatch): void {
    this.characters.update(name, { ...patch, updatedAt: Date.now() });
  }

  activate(name: string): boolean {
    return this.characters.activate(name, Date.now());
  }

  touch(name: string): void {
    this.characters.touch(name, Date.now());
  }

  delete(name: string, replacementName?: string): CharacterDeleteResult {
    return this.characters.delete(name, replacementName);
  }
}
