// 将角色立绘领域对象映射到立绘存储记录。

import { randomUUID } from 'node:crypto';
import {
  CharacterPortraitsRepo,
  type CharacterPortraitRow,
} from '@ema-agent/storage';
import {
  asCharacterPortraitId,
  type CharacterCardId,
  type CharacterPortraitId,
} from '@ema-agent/ids';
import type {
  CharacterPortrait,
  CharacterPortraitInput,
  CharacterPortraitPatch,
} from './types.js';

function fromRow(row: CharacterPortraitRow): CharacterPortrait {
  return {
    id: asCharacterPortraitId(row.id),
    characterCardId: row.character_card_id as CharacterCardId,
    label: row.label,
    relativePath: row.relative_path,
    position: row.position,
    isPrimary: row.is_primary === 1,
    enabled: row.enabled === 1,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterPortraitRepository {
  constructor(private readonly repo: CharacterPortraitsRepo) {}

  list(characterCardId: CharacterCardId): CharacterPortrait[] {
    return this.repo.listForCard(characterCardId).map(fromRow);
  }

  /** 批量取多张卡的立绘并按卡分组;Store 全量聚合用它替代逐卡查询。 */
  listForCards(
    characterCardIds: readonly CharacterCardId[],
  ): Map<CharacterCardId, CharacterPortrait[]> {
    const grouped = new Map<CharacterCardId, CharacterPortrait[]>();
    for (const row of this.repo.listForCards(characterCardIds)) {
      const cardId = row.character_card_id as CharacterCardId;
      const list = grouped.get(cardId) ?? [];
      list.push(fromRow(row));
      grouped.set(cardId, list);
    }
    return grouped;
  }

  insert(
    characterCardId: CharacterCardId,
    input: CharacterPortraitInput,
  ): CharacterPortrait {
    const id = input.id ?? asCharacterPortraitId(randomUUID());
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

  setPrimary(characterCardId: CharacterCardId, id: CharacterPortraitId): boolean {
    return this.repo.setPrimary(characterCardId, id, Date.now());
  }

  update(
    characterCardId: CharacterCardId,
    id: CharacterPortraitId,
    patch: CharacterPortraitPatch,
  ): CharacterPortrait | undefined {
    const row = this.repo.update(characterCardId, id, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  delete(
    characterCardId: CharacterCardId,
    id: CharacterPortraitId,
  ): CharacterPortrait | undefined {
    const row = this.repo.delete(characterCardId, id, Date.now());
    return row ? fromRow(row) : undefined;
  }
}
