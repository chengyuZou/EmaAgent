// 将角色立绘领域对象映射到立绘存储记录。

import { randomUUID } from 'node:crypto';
import {
  CharacterIllustrationRepo,
  type CharacterIllustrationRow,
} from '@ema-agent/storage';
import type {
  CharacterIllustration,
  CharacterIllustrationInput,
  CharacterIllustrationPatch,
} from './types.js';

function fromRow(row: CharacterIllustrationRow): CharacterIllustration {
  return {
    id: row.id,
    characterId: row.character_id,
    name: row.name,
    fileName: row.file_name,
    stageScale: row.stage_scale,
    stageOffsetX: row.stage_offset_x,
    stageOffsetY: row.stage_offset_y,
    isPrimary: row.is_primary === 1,
    enabled: row.enabled === 1,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterIllustrationRepository {
  constructor(private readonly repo: CharacterIllustrationRepo) {}

  list(characterId: string): CharacterIllustration[] {
    return this.repo.listForCharacter(characterId).map(fromRow);
  }

  /** 批量取多张角色的立绘并按角色分组；Store 全量聚合用它替代逐角色查询。 */
  listForCharacters(
    characterIds: readonly string[],
  ): Map<string, CharacterIllustration[]> {
    const grouped = new Map<string, CharacterIllustration[]>();
    for (const row of this.repo.listForCharacters(characterIds)) {
      const key = row.character_id;
      const list = grouped.get(key) ?? [];
      list.push(fromRow(row));
      grouped.set(key, list);
    }
    return grouped;
  }

  insert(
    characterId: string,
    input: CharacterIllustrationInput,
  ): CharacterIllustration {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.repo.insert({
      ...input,
      id,
      characterId,
      createdAt: now,
      updatedAt: now,
    });
    return fromRow(this.repo.findById(characterId, id)!);
  }

  setPrimary(characterId: string, id: string): boolean {
    return this.repo.setPrimary(characterId, id, Date.now());
  }

  update(
    characterId: string,
    id: string,
    patch: CharacterIllustrationPatch,
  ): CharacterIllustration | undefined {
    const row = this.repo.update(characterId, id, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  delete(
    characterId: string,
    id: string,
  ): CharacterIllustration | undefined {
    const row = this.repo.delete(characterId, id, Date.now());
    return row ? fromRow(row) : undefined;
  }
}
