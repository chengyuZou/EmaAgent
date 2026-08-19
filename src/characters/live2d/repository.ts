// 将单个角色的 Live2D 资源、主用状态与派生词汇映射到存储记录。

import { randomUUID } from 'node:crypto';
import {
  CharacterLive2dModelRepo,
  type CharacterLive2dModelRow,
} from '@ema-agent/storage';
import type {
  CharacterLive2dModel,
  CharacterLive2dModelInput,
  CharacterLive2dModelPatch,
} from './types.js';

function fromRow(row: CharacterLive2dModelRow): CharacterLive2dModel {
  return {
    id: row.id,
    characterId: row.character_id,
    name: row.name,
    directoryName: row.directory_name,
    emotionVocabulary: parseWords(row.emotion_vocab_json),
    motionVocabulary: parseWords(row.motion_vocab_json),
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

function parseWords(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.some((word) => typeof word !== 'string')) {
    throw new Error('Live2D vocabulary in SQLite must be a string array');
  }
  return parsed;
}

export class CharacterLive2dModelRepository {
  constructor(private readonly repo: CharacterLive2dModelRepo) {}

  list(characterId: string): CharacterLive2dModel[] {
    return this.repo.listForCharacter(characterId).map(fromRow);
  }

  /** 批量取多张角色的资源并按角色分组；Store 全量聚合用它替代逐角色查询。 */
  listForCharacters(
    characterIds: readonly string[],
  ): Map<string, CharacterLive2dModel[]> {
    const grouped = new Map<string, CharacterLive2dModel[]>();
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
    input: CharacterLive2dModelInput,
  ): CharacterLive2dModel {
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

  updateVocabularies(
    characterId: string,
    id: string,
    emotionVocabulary: readonly string[],
    motionVocabulary: readonly string[],
  ): CharacterLive2dModel | undefined {
    const row = this.repo.updateVocabularies(
      characterId, id, emotionVocabulary, motionVocabulary, Date.now());
    return row ? fromRow(row) : undefined;
  }

  update(
    characterId: string,
    id: string,
    patch: CharacterLive2dModelPatch,
  ): CharacterLive2dModel | undefined {
    const row = this.repo.update(characterId, id, patch, Date.now());
    return row ? fromRow(row) : undefined;
  }

  delete(
    characterId: string,
    id: string,
  ): CharacterLive2dModel | undefined {
    const row = this.repo.delete(characterId, id, Date.now());
    return row ? fromRow(row) : undefined;
  }
}
