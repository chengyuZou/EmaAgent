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

describe('data migration v12', () => {
  it('现有 v11 Goal 保留全部字段, 新反馈列初始为 null 且可以持久化', () => {
    database = new Database({ memory: true, kind: 'data' });
    const folder = fileURLToPath(new URL('../migrations/data/', import.meta.url));
    const migrations = fs.readdirSync(folder)
      .filter(name => name.endsWith('.sql') && Number.parseInt(name.slice(0, 3), 10) <= 11)
      .sort();
    for (const migration of migrations) {
      database.sqlite.exec(fs.readFileSync(new URL(`../migrations/data/${migration}`, import.meta.url), 'utf8'));
    }
    database.sqlite.pragma('user_version = 11');
    database.sqlite.exec(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
        VALUES ('goal-session', 'Keep session', '/workspace', 1, 2);
      INSERT INTO goals (id, session_id, objective, status, version, reason, error, created_at, updated_at, completed_at)
        VALUES ('old-goal', 'goal-session', 'Keep objective', 'active', 3, NULL, NULL, 4, 5, NULL);
    `);
    const before = database.sqlite.prepare('SELECT * FROM goals').get();
    database.migrate();
    expect(database.currentVersion()).toBe(12);
    expect(database.sqlite.prepare('SELECT * FROM goals').get()).toEqual({ ...before as object, feedback: null });
    database.sqlite.prepare('UPDATE goals SET feedback = ? WHERE id = ?').run('已完成第一部分', 'old-goal');
    expect(database.sqlite.prepare('SELECT feedback FROM goals WHERE id = ?').get('old-goal'))
      .toEqual({ feedback: '已完成第一部分' });
    expect(database.sqlite.prepare('SELECT title FROM sessions WHERE id = ?').get('goal-session'))
      .toEqual({ title: 'Keep session' });
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
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

    expect(database.currentVersion()).toBe(12);
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

describe('data migration v10', () => {
  it('保留全部旧权限与关联消息, 新约束接受 plan 且不留下临时列', () => {
    database = new Database({ memory: true, kind: 'data' });
    database.sqlite.exec(fs.readFileSync(
      fileURLToPath(new URL('../migrations/data/001_initial.sql', import.meta.url)), 'utf8',
    ));
    database.sqlite.pragma('user_version = 1');
    database.sqlite.exec(`
      INSERT INTO sessions (id, title, cwd, permission_mode, created_at, updated_at) VALUES
        ('default', 'Default', 'D:/work', 'default', 1, 1),
        ('edits', 'Edits', 'D:/work', 'acceptEdits', 2, 2),
        ('bypass', 'Bypass', 'D:/work', 'bypassPermissions', 3, 3);
      INSERT INTO turns (id, session_id, status, created_at)
        VALUES ('turn-1', 'edits', 'completed', 4);
      INSERT INTO messages (id, session_id, turn_id, role, blocks_json, created_at)
        VALUES ('message-1', 'edits', 'turn-1', 'user', '"Keep me"', 5);
      UPDATE sessions SET forked_from_session_id = 'edits', forked_from_turn_id = 'turn-1'
        WHERE id = 'bypass';
    `);
    const originalSessions = database.sqlite.prepare('SELECT * FROM sessions ORDER BY id').all();
    database.migrate();

    expect(database.sqlite.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(originalSessions);
    expect(database.sqlite.prepare('SELECT id, blocks_json FROM messages').all())
      .toEqual([{ id: 'message-1', blocks_json: '"Keep me"' }]);
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    const columns = database.sqlite.pragma('table_info(sessions)') as Array<{ name: string }>;
    expect(columns.map(column => column.name)).not.toContain('previous_permission_mode');
    database.sqlite.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run('plan', 'edits');
    expect(database.sqlite.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get('edits'))
      .toEqual({ permission_mode: 'plan' });
    expect(() => database!.sqlite.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?')
      .run('invalid', 'edits')).toThrow(/CHECK constraint failed/);
    expect(() => database!.sqlite.prepare('UPDATE sessions SET id = ? WHERE id = ?')
      .run('renamed', 'edits')).toThrow(/sessions.id is immutable/);
  });
});
