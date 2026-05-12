import type { SqliteDb } from '../database.js';
import type { CharacterCardId } from '@ema-agent/contracts';

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
  module_bindings_json: string;
  live2d_model_id: string | null;
  is_active: number;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

export interface CharacterCardInsert {
  id: CharacterCardId;
  name: string;
  version?: string;
  description?: string;
  systemPrompt: string;
  speechPatternsJson?: string;
  forbiddenTopicsJson?: string;
  emotionVocabJson?: string;
  motionVocabJson?: string;
  live2dModelId?: string;
  isActive?: boolean;
  isBuiltin?: boolean;
  createdAt: number;
  updatedAt: number;
}

export class CharacterCardsRepo {
  constructor(private readonly db: SqliteDb) {}

  insert(c: CharacterCardInsert): void {
    this.db
      .prepare(
        `INSERT INTO character_cards
           (id, name, version, description, system_prompt, speech_patterns_json,
            forbidden_topics_json, emotion_vocab_json, motion_vocab_json,
            live2d_model_id, is_active, is_builtin,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`
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
        c.live2dModelId ?? null,
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

  activate(id: CharacterCardId, updatedAt: number): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE character_cards SET is_active = 0').run();
      this.db
        .prepare('UPDATE character_cards SET is_active = 1, updated_at = ? WHERE id = ?')
        .run(updatedAt, id);
    })();
  }

  update(
    id: CharacterCardId,
    patch: Partial<Omit<CharacterCardInsert, 'id' | 'createdAt'>>,
  ): void {
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
    if (patch.live2dModelId !== undefined)       { fields.push('live2d_model_id = ?'); values.push(patch.live2dModelId); }

    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(now, id);

    this.db.prepare(`UPDATE character_cards SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  delete(id: CharacterCardId): void {
    this.db.prepare('DELETE FROM character_cards WHERE id = ? AND is_builtin = 0').run(id);
  }
}