// 将角色参考音频领域对象映射到音频存储记录。

import { randomUUID } from 'node:crypto';
import {
  CharacterVoiceSampleRepo,
  type CharacterVoiceSampleRow,
} from '@ema-agent/storage';
import type {
  CharacterVoiceSample,
  CharacterVoiceSampleInput,
  CharacterVoiceSamplePatch,
} from './types.js';

function fromRow(row: CharacterVoiceSampleRow): CharacterVoiceSample {
  return {
    id: row.id,
    characterId: row.character_id,
    name: row.name,
    fileName: row.file_name,
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

export class CharacterVoiceSampleRepository {
  constructor(private readonly repo: CharacterVoiceSampleRepo) {}

  list(characterId: string): CharacterVoiceSample[] {
    return this.repo.listForCharacter(characterId).map(fromRow);
  }

  /** 批量取多张角色的音频并按角色分组；Store 全量聚合用它替代逐角色查询。 */
  listForCharacters(
    characterIds: readonly string[],
  ): Map<string, CharacterVoiceSample[]> {
    const grouped = new Map<string, CharacterVoiceSample[]>();
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
    input: CharacterVoiceSampleInput,
  ): CharacterVoiceSample {
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

  setPrimary(
    characterId: string,
    id: string,
  ): boolean {
    return this.repo.setPrimary(characterId, id, Date.now());
  }

  update(
    characterId: string,
    id: string,
    patch: CharacterVoiceSamplePatch,
  ): CharacterVoiceSample | undefined {
    const row = this.repo.update(characterId, id, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  delete(
    characterId: string,
    id: string,
  ): CharacterVoiceSample | undefined {
    const row = this.repo.delete(characterId, id, Date.now());
    return row ? fromRow(row) : undefined;
  }
}
