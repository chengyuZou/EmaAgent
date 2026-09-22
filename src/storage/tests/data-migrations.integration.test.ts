// 验证 data v2 把旧 Turn Token 汇总迁入调用账本，并从 Turn 表删除重复事实。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../database/database.js';

let database: Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('data migration v2', () => {
  it('迁移旧汇总且不重复已有的 LLM Usage 记录', () => {
    database = new Database({ memory: true, kind: 'data' });
    const initialSql = fs.readFileSync(
      fileURLToPath(new URL('../migrations/data/001_initial.sql', import.meta.url)),
      'utf8',
    );
    database.sqlite.exec(initialSql);
    database.sqlite.pragma('user_version = 1');
    database.sqlite.prepare(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
      VALUES ('session-1', 'Session', 'D:/work', 1, 1)
    `).run();
    database.sqlite.prepare(`
      INSERT INTO turns (
        id, session_id, status, trigger_type, session_mode, narrative_policy,
        provider_id, model_id, usage_input_tokens, usage_output_tokens, created_at, completed_at
      ) VALUES
        ('turn-legacy', 'session-1', 'completed', 'userMessage', 'work', 'off',
         'provider', 'model', 100, 20, 10, 30),
        ('turn-recorded', 'session-1', 'completed', 'userMessage', 'work', 'off',
         'provider', 'model', 40, 8, 40, 50)
    `).run();
    database.sqlite.prepare(`
      INSERT INTO usage_records (
        id, session_id, turn_id, provider_id, model_id, capability, status,
        input_tokens, output_tokens, duration_ms, created_at
      ) VALUES (
        'existing-call', 'session-1', 'turn-recorded', 'provider', 'model', 'llm', 'completed',
        40, 8, 10, 50
      )
    `).run();

    database.migrate();

    expect(database.currentVersion()).toBe(2);
    const columns = database.sqlite.pragma('table_info(turns)') as Array<{ name: string }>;
    expect(columns.map(column => column.name)).not.toContain('usage_input_tokens');
    expect(columns.map(column => column.name)).not.toContain('usage_output_tokens');
    expect(database.sqlite.prepare(`
      SELECT id, turn_id, input_tokens, output_tokens
      FROM usage_records
      ORDER BY turn_id
    `).all()).toEqual([
      {
        id: 'migrated-turn-usage:turn-legacy',
        turn_id: 'turn-legacy',
        input_tokens: 100,
        output_tokens: 20,
      },
      {
        id: 'existing-call',
        turn_id: 'turn-recorded',
        input_tokens: 40,
        output_tokens: 8,
      },
    ]);
  });
});
