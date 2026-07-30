// 将角色参考音频领域对象映射到参考音频存储记录。

import { randomUUID } from 'node:crypto';
import {
  CharacterVoiceReferencesRepo,
  type CharacterVoiceReferenceRow,
} from '@ema-agent/storage';
import {
  asCharacterVoiceReferenceId,
  type CharacterCardId,
  type CharacterVoiceReferenceId,
} from '@ema-agent/ids';
import type {
  CharacterVoiceReference,
  CharacterVoiceReferenceInput,
} from './types.js';

function fromRow(row: CharacterVoiceReferenceRow): CharacterVoiceReference {
  return {
    id: asCharacterVoiceReferenceId(row.id),
    characterCardId: row.character_card_id as CharacterCardId,
    label: row.label,
    relativePath: row.relative_path,
    promptText: row.prompt_text,
    promptLang: row.prompt_lang,
    position: row.position,
    isPrimary: row.is_primary === 1,
    enabled: row.enabled === 1,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    durationMs: row.duration_ms,
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CharacterVoiceReferenceRepository {
  constructor(private readonly repo: CharacterVoiceReferencesRepo) {}

  list(characterCardId: CharacterCardId): CharacterVoiceReference[] {
    return this.repo.listForCard(characterCardId).map(fromRow);
  }

  insert(
    characterCardId: CharacterCardId,
    input: CharacterVoiceReferenceInput,
  ): CharacterVoiceReference {
    const id = input.id ?? asCharacterVoiceReferenceId(randomUUID());
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
    characterCardId: CharacterCardId,
    id: CharacterVoiceReferenceId,
  ): boolean {
    return this.repo.setPrimary(characterCardId, id, Date.now());
  }

  delete(
    characterCardId: CharacterCardId,
    id: CharacterVoiceReferenceId,
  ): CharacterVoiceReference | undefined {
    const row = this.repo.delete(characterCardId, id, Date.now());
    return row ? fromRow(row) : undefined;
  }
}
