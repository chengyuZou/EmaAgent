// 将角色参考音频领域对象映射到参考音频存储记录。

import { randomUUID } from 'node:crypto';
import {
  CharacterVoiceReferencesRepo,
  type CharacterVoiceReferenceRow,
} from '@ema-agent/storage';
import type {
  CharacterVoiceReference,
  CharacterVoiceReferenceInput,
  CharacterVoiceReferencePatch,
} from './types.js';

function fromRow(row: CharacterVoiceReferenceRow): CharacterVoiceReference {
  return {
    id: row.id,
    characterCardId: row.character_card_id,
    name: row.name,
    promptText: row.prompt_text,
    promptLang: row.prompt_lang,
    isPrimary: row.is_primary === 1,
    enabled: row.enabled === 1,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterVoiceReferenceRepository {
  constructor(private readonly repo: CharacterVoiceReferencesRepo) {}

  list(characterCardId: string): CharacterVoiceReference[] {
    return this.repo.listForCard(characterCardId).map(fromRow);
  }

  /** 批量取多张卡的参考音频并按卡分组;Store 全量聚合用它替代逐卡查询。 */
  listForCards(
    characterCardIds: readonly string[],
  ): Map<string, CharacterVoiceReference[]> {
    const grouped = new Map<string, CharacterVoiceReference[]>();
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
    input: CharacterVoiceReferenceInput,
  ): CharacterVoiceReference {
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

  setPrimary(
    characterCardId: string,
    id: string,
  ): boolean {
    return this.repo.setPrimary(characterCardId, id, Date.now());
  }

  update(
    characterCardId: string,
    id: string,
    patch: CharacterVoiceReferencePatch,
  ): CharacterVoiceReference | undefined {
    const row = this.repo.update(characterCardId, id, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  delete(
    characterCardId: string,
    id: string,
  ): CharacterVoiceReference | undefined {
    const row = this.repo.delete(characterCardId, id, Date.now());
    return row ? fromRow(row) : undefined;
  }
}
