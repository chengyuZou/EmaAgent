// 将角色立绘领域对象映射到立绘存储记录。

import { randomUUID } from 'node:crypto';
import {
  CharacterIllustrationsRepo,
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
    characterCardId: row.character_card_id,
    name: row.name,
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
  constructor(private readonly repo: CharacterIllustrationsRepo) {}

  list(characterCardId: string): CharacterIllustration[] {
    return this.repo.listForCard(characterCardId).map(fromRow);
  }

  /** 批量取多张卡的立绘并按卡分组;Store 全量聚合用它替代逐卡查询。 */
  listForCards(
    characterCardIds: readonly string[],
  ): Map<string, CharacterIllustration[]> {
    const grouped = new Map<string, CharacterIllustration[]>();
    for (const row of this.repo.listForCards(characterCardIds)) {
      const cardId = row.character_card_id;
      const list = grouped.get(cardId) ?? [];
      list.push(fromRow(row));
      grouped.set(cardId, list);
    }
    return grouped;
  }

  insert(
    characterCardId: string,
    input: CharacterIllustrationInput,
  ): CharacterIllustration {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.repo.insert({
      ...input,
      id,
      characterCardId,
      createdAt: now,
      updatedAt: now,
    });
    return fromRow(this.repo.findById(characterCardId, id)!);
  }

  setPrimary(characterCardId: string, id: string): boolean {
    return this.repo.setPrimary(characterCardId, id, Date.now());
  }

  update(
    characterCardId: string,
    id: string,
    patch: CharacterIllustrationPatch,
  ): CharacterIllustration | undefined {
    const row = this.repo.update(characterCardId, id, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  delete(
    characterCardId: string,
    id: string,
  ): CharacterIllustration | undefined {
    const row = this.repo.delete(characterCardId, id, Date.now());
    return row ? fromRow(row) : undefined;
  }
}
