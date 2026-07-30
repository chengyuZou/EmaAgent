// 这里把角色卡领域对象和数据库行互相转换，是 store 和 storage repo 之间的薄适配层。

import { randomUUID } from 'node:crypto';
import type { CharacterCardsRepo, CharacterCardRow } from '@ema-agent/storage';
import { asCharacterCardId } from '@ema-agent/ids';
import type { CharacterCardId } from '@ema-agent/ids';
import type { CharacterCard, CharacterCardInput } from './types.js';

// ── 数据库行 -> 领域对象 ──────────────────────────────────────────────────────────

function fromRow(row: CharacterCardRow): CharacterCard {
  return {
    id:               asCharacterCardId(row.id),
    name:             row.name,
    version:          row.version,
    description:      row.description,
    systemPrompt:     row.system_prompt,
    speechPatterns:   JSON.parse(row.speech_patterns_json) as string[],
    forbiddenTopics:  JSON.parse(row.forbidden_topics_json) as string[],
    emotionVocabulary: JSON.parse(row.emotion_vocab_json) as string[],
    motionVocabulary:  JSON.parse(row.motion_vocab_json) as string[],
    live2dVariants:   [],
    portraits:        [],
    voiceReferences:  [],
    isActive:         row.is_active === 1,
    isBuiltin:        row.is_builtin === 1,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

// ── CharacterCardRepository ──────────────────────────────────────────────────

/** CharacterCardsRepo 上的薄领域适配层--领域类型 <-> DB 行。 */
export class CharacterCardRepository {
  constructor(private readonly repo: CharacterCardsRepo) {}

  findById(id: CharacterCardId): CharacterCard | undefined {
    const row = this.repo.findById(id);
    return row ? fromRow(row) : undefined;
  }

  findActive(): CharacterCard | undefined {
    const row = this.repo.findActive();
    return row ? fromRow(row) : undefined;
  }

  list(): CharacterCard[] {
    return this.repo.list().map(fromRow);
  }

  insert(
    input: CharacterCardInput,
    opts: { id?: string; isBuiltin?: boolean; isActive?: boolean } = {},
  ): CharacterCard {
    const now = Date.now();
    const id = asCharacterCardId(opts.id ?? randomUUID());

    this.repo.insert({
      id,
      name:                 input.name,
      version:              input.version,
      description:          input.description,
      systemPrompt:         input.systemPrompt,
      speechPatternsJson:   JSON.stringify(input.speechPatterns ?? []),
      forbiddenTopicsJson:  JSON.stringify(input.forbiddenTopics ?? []),
      emotionVocabJson:     JSON.stringify(input.emotionVocabulary ?? []),
      motionVocabJson:      JSON.stringify(input.motionVocabulary ?? []),
      isActive:             opts.isActive ?? false,
      isBuiltin:            opts.isBuiltin ?? false,
      createdAt:            now,
      updatedAt:            now,
    });

    return this.findById(id)!;
  }

  update(id: CharacterCardId, patch: Partial<CharacterCardInput>): void {
    this.repo.update(id, {
      name:                 patch.name,
      version:              patch.version,
      description:          patch.description,
      systemPrompt:         patch.systemPrompt,
      speechPatternsJson:   patch.speechPatterns !== undefined
                              ? JSON.stringify(patch.speechPatterns) : undefined,
      forbiddenTopicsJson:  patch.forbiddenTopics !== undefined
                              ? JSON.stringify(patch.forbiddenTopics) : undefined,
      emotionVocabJson:     patch.emotionVocabulary !== undefined
                              ? JSON.stringify(patch.emotionVocabulary) : undefined,
      motionVocabJson:      patch.motionVocabulary !== undefined
                              ? JSON.stringify(patch.motionVocabulary) : undefined,
      updatedAt:            Date.now(),
    });
  }

  activate(id: CharacterCardId): void {
    this.repo.activate(id, Date.now());
  }

  /** 静默拒绝删除内置卡（由 storage repo 强制）。 */
  delete(id: CharacterCardId): void {
    this.repo.delete(id);
  }
}
