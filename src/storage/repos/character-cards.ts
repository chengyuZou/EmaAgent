import type { SqliteDb } from '../database.js';
import type { CharacterCardId } from '@ema-agent/ids';
import type { ProtectedDeleteResult } from './mutation-results.js';

export interface CharacterCardRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  system_prompt: string;
  speech_patterns_json: string;
  forbidden_topics_json: string;
  emotion_vocab_json: string;
  motion_vocab_json: string;
  is_active: number;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

export interface CharacterCardInsert {
  id: CharacterCardId;
  name: string;
  version?: string;
  description?: string | null;
  systemPrompt: string;
  speechPatternsJson?: string;
  forbiddenTopicsJson?: string;
  emotionVocabJson?: string;
  motionVocabJson?: string;
  isActive?: boolean;
  isBuiltin?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 普通编辑允许修改的字段；激活状态和内置标记由专用流程管理。 */
export interface CharacterCardUpdate {
  name?: string;
  version?: string;
  description?: string | null;
  systemPrompt?: string;
  speechPatternsJson?: string;
  forbiddenTopicsJson?: string;
  emotionVocabJson?: string;
  motionVocabJson?: string;
  updatedAt?: number;
}

export class CharacterCardUpdateContractError extends Error {
  readonly code = 'storage/character-card-reserved-field';

  constructor(readonly field: 'isActive' | 'isBuiltin') {
    super(
      field === 'isActive'
        ? 'Character card active state must be changed through activate()'
        : 'Character card builtin state is immutable after insertion',
    );
    this.name = 'CharacterCardUpdateContractError';
  }
}

export class CharacterCardsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(c: CharacterCardInsert): void {
    this.db
      .prepare(
        `INSERT INTO character_cards
           (id, name, version, description, system_prompt, speech_patterns_json,
            forbidden_topics_json, emotion_vocab_json, motion_vocab_json, is_active,
            is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        c.id,
        c.name,
        c.version ?? 'v1.0.0',
        c.description ?? null,
        c.systemPrompt,
        c.speechPatternsJson ?? '[]',
        c.forbiddenTopicsJson ?? '[]',
        c.emotionVocabJson ?? '[]',
        c.motionVocabJson ?? '[]',
        c.isActive ? 1 : 0,
        c.isBuiltin ? 1 : 0,
        c.createdAt,
        c.updatedAt,
      );
  }

  findById(id: CharacterCardId): CharacterCardRow | undefined {
    return this.db
      .prepare('SELECT * FROM character_cards WHERE id = ?')
      .get(id) as CharacterCardRow | undefined;
  }

  findActive(): CharacterCardRow | undefined {
    return this.db
      .prepare('SELECT * FROM character_cards WHERE is_active = 1 LIMIT 1')
      .get() as CharacterCardRow | undefined;
  }

  list(): CharacterCardRow[] {
    return this.db
      .prepare('SELECT * FROM character_cards ORDER BY is_builtin DESC, name ASC')
      .all() as CharacterCardRow[];
  }

  activate(id: CharacterCardId, updatedAt: number): boolean {
    return this.db.transaction(() => {
      const target = this.db
        .prepare('SELECT is_active FROM character_cards WHERE id = ?')
        .get(id) as { is_active: number } | undefined;

      // 必须先确认目标存在，避免错误 ID 清空当前角色卡。
      if (!target) return false;
      if (target.is_active === 1) return true;

      this.db.prepare('UPDATE character_cards SET is_active = 0 WHERE is_active = 1').run();
      this.db
        .prepare('UPDATE character_cards SET is_active = 1, updated_at = ? WHERE id = ?')
        .run(updatedAt, id);
      return true;
    })();
  }

  update(id: CharacterCardId, patch: CharacterCardUpdate): void {
    const untrustedPatch = patch as CharacterCardUpdate & Record<string, unknown>;
    for (const field of ['isActive', 'isBuiltin'] as const) {
      if (Object.prototype.hasOwnProperty.call(untrustedPatch, field)) {
        throw new CharacterCardUpdateContractError(field);
      }
    }

    const now = patch.updatedAt ?? Date.now();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (patch.name !== undefined)                { fields.push('name = ?'); values.push(patch.name); }
    if (patch.version !== undefined)             { fields.push('version = ?'); values.push(patch.version); }
    if (patch.description !== undefined)         { fields.push('description = ?'); values.push(patch.description); }
    if (patch.systemPrompt !== undefined)        { fields.push('system_prompt = ?'); values.push(patch.systemPrompt); }
    if (patch.speechPatternsJson !== undefined)  { fields.push('speech_patterns_json = ?'); values.push(patch.speechPatternsJson); }
    if (patch.forbiddenTopicsJson !== undefined) { fields.push('forbidden_topics_json = ?'); values.push(patch.forbiddenTopicsJson); }
    if (patch.emotionVocabJson !== undefined)    { fields.push('emotion_vocab_json = ?'); values.push(patch.emotionVocabJson); }
    if (patch.motionVocabJson !== undefined)     { fields.push('motion_vocab_json = ?'); values.push(patch.motionVocabJson); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(now, id);

    this.db.prepare(`UPDATE character_cards SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  delete(id: CharacterCardId): ProtectedDeleteResult {
    return this.db.transaction(() => {
      const deleted = this.db
        .prepare('DELETE FROM character_cards WHERE id = ? AND is_builtin = 0')
        .run(id);
      if (deleted.changes === 1) return 'deleted';

      const existing = this.db
        .prepare('SELECT 1 FROM character_cards WHERE id = ?')
        .get(id);
      return existing ? 'builtin_protected' : 'not_found';
    })();
  }
}
