// 在一个 SQLite 事务内维护角色定义与 Prompt Block 聚合，并完成数据库行映射。

import { randomUUID } from 'node:crypto';
import {
  CharacterRepo,
  CharacterPromptBlockRepo,
  type CharacterRow,
  type CharacterPromptBlockRow,
  type ProtectedDeleteResult,
  type SqliteDb,
} from '@ema-agent/storage';
import type {
  Character,
  CharacterInput,
  CharacterPromptBlock,
  CharacterPromptBlockInput,
  CharacterPromptBlockPatch,
} from './types.js';

function fromRow(row: CharacterRow, blocks: readonly CharacterPromptBlock[]): Character {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    directoryName: row.directory_name,
    promptBlocks: blocks,
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

function fromBlockRow(row: CharacterPromptBlockRow): CharacterPromptBlock {
  return {
    id: row.id,
    characterId: row.character_id,
    name: row.name,
    content: row.content,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterRepository {
  constructor(
    private readonly db: SqliteDb,
    private readonly characters: CharacterRepo,
    private readonly blocks: CharacterPromptBlockRepo,
  ) {}

  findById(id: string): Character | undefined {
    const row = this.characters.findById(id);
    return row ? fromRow(row, this.listBlocks(id)) : undefined;
  }

  findActive(): Character | undefined {
    const row = this.characters.findActive();
    return row ? fromRow(row, this.listBlocks(row.id)) : undefined;
  }

  list(): Character[] {
    const rows = this.characters.list();
    const grouped = new Map<string, CharacterPromptBlock[]>();
    for (const block of this.blocks.listForCharacters(rows.map((row) => row.id))) {
      const values = grouped.get(block.character_id) ?? [];
      values.push(fromBlockRow(block));
      grouped.set(block.character_id, values);
    }
    return rows.map((row) => fromRow(row, grouped.get(row.id) ?? []));
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
    this.db.transaction(() => {
      this.characters.insert({
        id,
        name: input.name,
        description: input.description ?? null,
        directoryName,
        isActive,
        isBuiltin,
        createdAt: now,
        updatedAt: now,
      });
      this.blocks.insertMany(input.promptBlocks.map((block, index) =>
        toBlockInsert(id, block, index, now),
      ));
    })();
    return this.findById(id)!;
  }

  update(id: string, name: string | undefined, description: string | null | undefined): void {
    this.characters.update(id, { name, description, updatedAt: Date.now() });
  }

  activate(id: string): void {
    this.characters.activate(id, Date.now());
  }

  delete(id: string): ProtectedDeleteResult {
    return this.characters.delete(id);
  }

  listBlocks(characterId: string): CharacterPromptBlock[] {
    return this.blocks.listForCharacter(characterId).map(fromBlockRow);
  }

  insertBlock(characterId: string, input: CharacterPromptBlockInput): CharacterPromptBlock {
    const now = Date.now();
    const sortOrder = this.blocks.listForCharacter(characterId).length;
    const row = toBlockInsert(characterId, input, sortOrder, now);
    this.blocks.insert(row);
    return fromBlockRow(this.blocks.findById(characterId, row.id)!);
  }

  updateBlock(
    characterId: string,
    blockId: string,
    patch: CharacterPromptBlockPatch,
  ): CharacterPromptBlock | undefined {
    const row = this.blocks.update(characterId, blockId, {
      name: patch.name,
      content: patch.content,
      enabled: patch.enabled,
      updatedAt: Date.now(),
    });
    return row ? fromBlockRow(row) : undefined;
  }

  deleteBlock(characterId: string, blockId: string): boolean {
    return this.blocks.delete(characterId, blockId);
  }

  reorderBlocks(characterId: string, orderedIds: readonly string[]): boolean {
    return this.blocks.reorder(characterId, orderedIds, Date.now());
  }
}

function toBlockInsert(
  characterId: string,
  block: CharacterPromptBlockInput,
  sortOrder: number,
  now: number,
): {
  id: string;
  characterId: string;
  name: string;
  content: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
} {
  return {
    id: randomUUID(),
    characterId,
    name: block.name,
    content: block.content,
    enabled: block.enabled ?? true,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
}
