// 将 Live2D/VRM 领域资源映射到角色变体存储记录。

import { randomUUID } from 'node:crypto';
import {
  CharacterLive2dVariantsRepo,
  type CharacterLive2dVariantRow,
} from '@ema-agent/storage';
import {
  asCharacterLive2dId,
  type CharacterCardId,
  type CharacterLive2dId,
} from '@ema-agent/ids';
import type {
  CharacterLive2dVariant,
  CharacterLive2dVariantInput,
} from './types.js';

function fromRow(row: CharacterLive2dVariantRow): CharacterLive2dVariant {
  return {
    id: asCharacterLive2dId(row.id),
    characterCardId: row.character_card_id as CharacterCardId,
    label: row.label,
    format: row.format,
    entryPath: row.entry_path,
    runtimeConfigPath: row.runtime_config_path,
    position: row.position,
    isPrimary: row.is_primary === 1,
    enabled: row.enabled === 1,
    resourceVersion: row.resource_version,
    contentSha256: row.content_sha256,
    byteSize: row.byte_size,
    isBuiltin: row.is_builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterLive2dRepository {
  constructor(private readonly repo: CharacterLive2dVariantsRepo) {}

  list(characterCardId: CharacterCardId): CharacterLive2dVariant[] {
    return this.repo.listForCard(characterCardId).map(fromRow);
  }

  insert(
    characterCardId: CharacterCardId,
    input: CharacterLive2dVariantInput,
  ): CharacterLive2dVariant {
    const id = input.id ?? asCharacterLive2dId(randomUUID());
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

  setPrimary(characterCardId: CharacterCardId, id: CharacterLive2dId): boolean {
    return this.repo.setPrimary(characterCardId, id, Date.now());
  }

  delete(
    characterCardId: CharacterCardId,
    id: CharacterLive2dId,
  ): CharacterLive2dVariant | undefined {
    const row = this.repo.delete(characterCardId, id, Date.now());
    return row ? fromRow(row) : undefined;
  }
}
