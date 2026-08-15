// 角色卡领域对象和数据库行互相转换，是 store 和 storage repo 之间的薄适配层。

import { randomUUID } from 'node:crypto';
import type { CharacterCardsRepo, CharacterCardRow } from '@ema-agent/storage';
import type { CharacterCard, CharacterCardInput } from './types.js';

// ── 数据库行 -> 领域对象 ──────────────────────────────────────────────────────────

function fromRow(row: CharacterCardRow): CharacterCard {
  return {
    id:               row.id,
    name:             row.name,
    description:      row.description,
    systemPrompt:     row.system_prompt,
    emotionVocabulary: JSON.parse(row.emotion_vocab_json) as string[],
    motionVocabulary:  JSON.parse(row.motion_vocab_json) as string[],
    live2dVariants:   [],
    illustrations:    [],
    voiceReferences:  [],
    isActive:         row.is_active === 1,
    isBuiltin:        row.is_builtin === 1,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

/** CharacterCardsRepo 上的薄领域适配层--领域类型 <-> DB 行。 */
export class CharacterCardRepository {
  constructor(private readonly repo: CharacterCardsRepo) {}

  findById(id: string): CharacterCard | undefined {
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
    const id = opts.id ?? randomUUID();

    this.repo.insert({
      id,
      name:                 input.name,
      description:          input.description,
      systemPrompt:         input.systemPrompt,
      emotionVocabJson:     '[]',
      motionVocabJson:      '[]',
      isActive:             opts.isActive ?? false,
      isBuiltin:            opts.isBuiltin ?? false,
      createdAt:            now,
      updatedAt:            now,
    });

    return this.findById(id)!;
  }

  update(id: string, patch: Partial<CharacterCardInput>): void {
    this.repo.update(id, {
      name:                 patch.name,
      description:          patch.description,
      systemPrompt:         patch.systemPrompt,
      updatedAt:            Date.now(),
    });
  }

  /** 仅供主用 Live2D 变更流程写入派生词汇，普通角色编辑不能修改这两列。 */
  updateLive2dVocabulary(
    id: string,
    emotionVocabulary: readonly string[],
    motionVocabulary: readonly string[],
  ): void {
    this.repo.update(id, {
      emotionVocabJson: JSON.stringify(emotionVocabulary),
      motionVocabJson: JSON.stringify(motionVocabulary),
      updatedAt: Date.now(),
    });
  }

  activate(id: string): void {
    this.repo.activate(id, Date.now());
  }

  /** 静默拒绝删除内置卡（由 storage repo 强制）。 */
  delete(id: string): void {
    this.repo.delete(id);
  }
}
