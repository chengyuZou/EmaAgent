// 在一个 SQLite 事务内维护角色定义聚合，并完成数据库行映射。

import { randomUUID } from 'node:crypto';
import {
  CharacterRepo,
  type CharacterRow,
  type ProtectedDeleteResult,
  type SqliteDb,
} from '@ema-agent/storage';
import type { Character, CharacterInput } from './types.js';

function fromRow(row: CharacterRow): Character {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    directoryName: row.directory_name,
    personaPrompt: row.persona_prompt,
    emotionVocabulary: [],
    motionVocabulary: [],
    live2dModels: [],
    illustrations: [],
    voiceSamples: [],
    isActive: row.is_active === 1,
    isBuiltin: row.is_builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterRepository {
  constructor(
    private readonly db: SqliteDb,
    private readonly characters: CharacterRepo,
  ) {}

  findById(id: string): Character | undefined {
    const row = this.characters.findById(id);
    return row ? fromRow(row) : undefined;
  }

  findActive(): Character | undefined {
    const row = this.characters.findActive();
    return row ? fromRow(row) : undefined;
  }

  list(): Character[] {
    return this.characters.list().map(fromRow);
  }

  insert(
    input: CharacterInput,
    directoryName: string,
    id: string = randomUUID(),
    isBuiltin = false,
    isActive = false,
  ): Character {
    if (this.characters.findByDirectoryName(directoryName)) {
      throw new Error(`character directory name already exists: ${directoryName}`);
    }
    const now = Date.now();
    this.characters.insert({
      id,
      name: input.name,
      description: input.description ?? null,
      directoryName,
      personaPrompt: input.personaPrompt,
      isActive,
      isBuiltin,
      createdAt: now,
      updatedAt: now,
    });
    return this.findById(id)!;
  }

  update(
    id: string,
    name: string | undefined,
    description: string | null | undefined,
    personaPrompt: string | undefined,
  ): void {
    this.characters.update(id, { name, description, personaPrompt, updatedAt: Date.now() });
  }

  activate(id: string): void {
    this.characters.activate(id, Date.now());
  }

  delete(id: string): ProtectedDeleteResult {
    return this.characters.delete(id);
  }
}
