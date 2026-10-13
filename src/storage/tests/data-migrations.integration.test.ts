// 验证 data v2 把旧 Turn Token 汇总迁入调用账本，并从 Turn 表删除重复事实。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../database/database.js';
import { SpeechOutputsRepo } from '../repos/data/speechOutputs.js';

let database: Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe('data migration v13', () => {
  it('旧身份、结果、ToolCall 关联和消息游标完整搬入新三表, 不补造来源或历史', () => {
    database = new Database({ memory: true, kind: 'data' });
    const folder = fileURLToPath(new URL('../migrations/data/', import.meta.url));
    for (const name of fs.readdirSync(folder).filter(name => name.endsWith('.sql') && Number.parseInt(name.slice(0, 3), 10) <= 12).sort()) {
      database.sqlite.exec(fs.readFileSync(new URL(`../migrations/data/${name}`, import.meta.url), 'utf8'));
    }
    database.sqlite.pragma('user_version = 12');
    database.sqlite.exec(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('s', 'keep', '/workspace', 1, 2);
      INSERT INTO turns (id, session_id, status, created_at) VALUES ('t', 's', 'completed', 3);
      INSERT INTO messages (id, session_id, turn_id, role, blocks_json, created_at)
        VALUES ('root-message', 's', 't', 'user', '"keep"', 4);
      INSERT INTO subagents (
        id, session_id, context_mode, description, provider_id, model_id, status, error,
        iterations, tool_call_count, input_tokens, output_tokens, final_text, created_at, updated_at, completed_at
      ) VALUES ('child', 's', 'fork', 'old description', 'p', 'm', 'completed', NULL, 2, 3, 100, 20, 'old result', 5, 9, 9);
      INSERT INTO subagents (id, session_id, context_mode, status, created_at, updated_at)
        VALUES ('running-child', 's', 'subagent', 'running', 6, 6);
      INSERT INTO subagent_invocations (tool_call_id, subagent_id, created_at)
        VALUES ('parent-call', 'child', 5), ('parent-running', 'running-child', 6);
      INSERT INTO subagent_messages (id, subagent_id, role, kind, blocks_json, interrupted, sequence, created_at)
        VALUES ('child-message', 'child', 'assistant', 'normal', '[{"type":"reasoning","id":"native","encryptedContent":"encrypted"}]', 1, 1, 7);
      INSERT INTO subagent_messages (id, subagent_id, role, kind, blocks_json, sequence, created_at, summarized_through_message_id)
        VALUES ('child-summary', 'child', 'user', 'summary', '"summary"', 2, 8, 'child-message');
      INSERT INTO tool_executions (call_id, session_id, turn_id, subagent_id, tool_name, status, created_at, updated_at)
        VALUES ('inner-call', 's', 't', 'child', 'Read', 'succeeded', 7, 8);
    `);
    const sessionsBefore = (database.sqlite.prepare('SELECT * FROM sessions').all() as Array<{
      narrative_policy: string;
      session_mode: string;
    }>).map(({ narrative_policy, session_mode, ...session }) => session);
    const messagesBefore = database.sqlite.prepare('SELECT * FROM messages').all();
    const toolsBefore = database.sqlite.prepare('SELECT * FROM tool_executions').all();
    database.migrate();
    expect(database.currentVersion()).toBe(17);
    expect(database.sqlite.prepare('SELECT * FROM subagents ORDER BY id').all()).toEqual([
      {
        id: 'child', session_id: 's', title: null, description: 'old description',
        provider_id: 'p', model_id: 'm', protocol: null, permission_mode: null, reasoning_effort: null,
        status: 'completed', created_at: 5, updated_at: 9,
      },
      {
        id: 'running-child', session_id: 's', title: null, description: null,
        provider_id: null, model_id: null, protocol: null, permission_mode: null, reasoning_effort: null,
        status: 'running', created_at: 6, updated_at: 6,
      },
    ]);
    const runs = database.sqlite.prepare('SELECT * FROM subagent_runs ORDER BY created_at').all() as Array<{ id: string }>;
    expect(runs).toMatchObject([
      { subagent_id: 'child', parent_tool_call_id: 'parent-call', context_mode: 'fork', description: 'old description', provider_id: 'p', model_id: 'm', protocol: null, status: 'completed', iterations: 2, tool_call_count: 3, input_tokens: 100, output_tokens: 20, final_text: 'old result', created_at: 5, updated_at: 9, completed_at: 9 },
      { subagent_id: 'running-child', parent_tool_call_id: 'parent-running', status: 'running', provider_id: null, protocol: null },
    ]);
    expect(runs[0]!.id).not.toBe('child');
    expect(runs[0]!.id).not.toBe('parent-call');
    const identityColumns = database.sqlite.pragma('table_info(subagents)') as Array<{ name: string }>;
    for (const column of ['iterations', 'tool_call_count', 'input_tokens', 'output_tokens', 'duration_ms', 'context_mode', 'latest_run_id']) {
      expect(identityColumns.map(item => item.name)).not.toContain(column);
    }
    expect(runs).toMatchObject([
      { permission_mode: null, reasoning_effort: null },
      { permission_mode: null, reasoning_effort: null },
    ]);
    expect(database.sqlite.prepare('SELECT * FROM subagent_messages ORDER BY created_at, id').all()).toMatchObject([
      { id: 'child-message', run_id: runs[0]!.id, created_at: 7, interrupted: 1, blocks_json: '[{"type":"reasoning","id":"native","encryptedContent":"encrypted"}]', provider_id: null, model_id: null, protocol: null },
      { id: 'child-summary', run_id: runs[0]!.id, created_at: 8, summarized_through_message_id: 'child-message', summary_saved_tokens: null },
    ]);
    expect(database.sqlite.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('subagent_invocations')).toBeUndefined();
    expect(database.sqlite.prepare('SELECT * FROM sessions').all()).toEqual(sessionsBefore);
    expect(database.sqlite.prepare('SELECT * FROM messages').all()).toEqual(messagesBefore);
    expect(database.sqlite.prepare('SELECT * FROM tool_executions').all()).toEqual(toolsBefore);
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    database.migrate();
    expect(database.sqlite.prepare('SELECT id FROM subagent_runs ORDER BY created_at').all())
      .toEqual(runs.map(run => ({ id: run.id })));
  });
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
    expect(database.currentVersion()).toBe(17);
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
        id, session_id, status, trigger_type, session_mode,
        provider_id, model_id, usage_input_tokens, usage_output_tokens, created_at, completed_at
      ) VALUES
        ('turn-legacy', 'session-1', 'completed', 'userMessage', 'work',
         'provider', 'model', 100, 20, 10, 30),
        ('turn-recorded', 'session-1', 'completed', 'userMessage', 'work',
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

    expect(database.currentVersion()).toBe(17);
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
    const originalSessions = (database.sqlite.prepare('SELECT * FROM sessions ORDER BY id').all() as Array<{
      narrative_policy: string;
      session_mode: string;
    }>).map(({ narrative_policy, session_mode, ...session }) => session);
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

describe('data migration v16', () => {
  it('移除两张表的模式列, 会话偏好, 消息和 Turn 其余字段保留', () => {
    database = new Database({ memory: true, kind: 'data' });
    const folder = fileURLToPath(new URL('../migrations/data/', import.meta.url));
    const migrations = fs.readdirSync(folder)
      .filter(name => name.endsWith('.sql') && Number.parseInt(name, 10) <= 15)
      .sort();
    for (const name of migrations) {
      database.sqlite.exec(fs.readFileSync(new URL(`../migrations/data/${name}`, import.meta.url), 'utf8'));
    }
    database.sqlite.pragma('user_version = 15');
    database.sqlite.exec(`
      INSERT INTO sessions (id, title, cwd, session_mode, permission_mode, created_at, updated_at)
        VALUES ('kept', 'Keep', 'D:/work', 'work', 'plan', 1, 2);
      INSERT INTO turns (id, session_id, status, session_mode, character_name, created_at)
        VALUES ('kept-turn', 'kept', 'completed', 'chat', 'ema', 3);
      INSERT INTO messages (id, session_id, turn_id, role, blocks_json, created_at)
        VALUES ('kept-message', 'kept', 'kept-turn', 'user', '"Keep me"', 4);
    `);
    const session = database.sqlite.prepare('SELECT * FROM sessions').get() as { session_mode: string };
    const turn = database.sqlite.prepare('SELECT * FROM turns').get() as { session_mode: string };
    const { session_mode: sessionMode, ...expectedSession } = session;
    const { session_mode: turnMode, ...expectedTurn } = turn;
    const messages = database.sqlite.prepare('SELECT * FROM messages').all();
    database.migrate();
    expect(database.currentVersion()).toBe(17);
    expect(database.sqlite.prepare('SELECT * FROM sessions').get()).toEqual(expectedSession);
    expect(database.sqlite.prepare('SELECT * FROM turns').get()).toEqual(expectedTurn);
    expect(database.sqlite.prepare('SELECT * FROM messages').all()).toEqual(messages);
    for (const table of ['sessions', 'turns']) {
      const columns = database.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
      expect(columns.map(column => column.name)).not.toContain('session_mode');
    }
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('data migration v17', () => {
  it('已有单轮主键表升级后保留 WAV, 可以新增角色版本和按路径重新生成', () => {
    database = new Database({ memory: true, kind: 'data' });
    const folder = fileURLToPath(new URL('../migrations/data/', import.meta.url));
    const migrations = fs.readdirSync(folder)
      .filter(name => name.endsWith('.sql') && Number.parseInt(name, 10) <= 16)
      .sort();
    for (const name of migrations) {
      database.sqlite.exec(fs.readFileSync(new URL(`../migrations/data/${name}`, import.meta.url), 'utf8'));
    }
    database.sqlite.pragma('user_version = 16');
    // 当前基线已经按路径建表, 这里还原实际 v16 库的单轮主键才能复现写入错误.
    database.sqlite.exec(`
      DROP TABLE speech_outputs;
      CREATE TABLE speech_outputs (
        turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        storage_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
        VALUES ('speech', 'Keep speech', 'D:/work', 1, 2),
          ('other', 'Other session', 'D:/work', 1, 2);
      INSERT INTO turns (id, session_id, status, created_at)
        VALUES ('reply', 'speech', 'completed', 3);
      INSERT INTO speech_outputs (
        turn_id, session_id, storage_path, mime_type, byte_size, duration_ms, created_at
      ) VALUES (
        'reply', 'speech', 'D:/data/sessions/speech/audio/reply/reply-樱羽艾玛.wav',
        'audio/wav', 2044, 1000, 4
      );
    `);
    const original = database.sqlite.prepare('SELECT * FROM speech_outputs').get();

    database.migrate();

    expect(database.currentVersion()).toBe(17);
    expect(database.sqlite.prepare('SELECT * FROM speech_outputs').get()).toEqual(original);
    const columns = database.sqlite.pragma('table_info(speech_outputs)') as Array<{
      name: string;
      pk: number;
    }>;
    expect(columns.filter(column => column.pk > 0).map(column => column.name))
      .toEqual(['storage_path']);

    const outputs = new SpeechOutputsRepo(database.sqlite);
    const regenerated = {
      turnId: 'reply',
      sessionId: 'speech',
      storagePath: 'D:/data/sessions/speech/audio/reply/reply-希罗.wav',
      mimeType: 'audio/wav' as const,
      byteSize: 4044,
      durationMs: 2000,
      createdAt: 5,
    };
    outputs.record(regenerated);
    outputs.record({ ...regenerated, byteSize: 6044, durationMs: 3000, createdAt: 6 });
    const records = outputs.listForTurn('reply');
    expect(records).toHaveLength(2);
    expect(records.find(record => record.storage_path.endsWith('-樱羽艾玛.wav')))
      .toEqual(original);
    expect(records.find(record => record.storage_path === regenerated.storagePath))
      .toMatchObject({ byte_size: 6044, duration_ms: 3000, created_at: 6 });
    expect(() => outputs.record({
      ...regenerated,
      sessionId: 'other',
      storagePath: 'D:/data/sessions/other/audio/reply/reply-希罗.wav',
    })).toThrow(/ownership_violation/);
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('profile migration v7', () => {
  it.each([null, 30, 80, 100])('采用已有 Work 上限 %s, 不保留两份模式设置', workLimit => {
    database = new Database({ memory: true, kind: 'profile' });
    const folder = fileURLToPath(new URL('../migrations/profile/', import.meta.url));
    const migrations = fs.readdirSync(folder)
      .filter(name => name.endsWith('.sql') && Number.parseInt(name, 10) <= 6)
      .sort();
    for (const name of migrations) {
      database.sqlite.exec(fs.readFileSync(new URL(`../migrations/profile/${name}`, import.meta.url), 'utf8'));
    }
    database.sqlite.pragma('user_version = 6');
    const insert = database.sqlite.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)');
    insert.run('agent.limits.chatMaxIterations', '10', 1);
    insert.run('agent.limits.maxConcurrentSubagents', '4', 2);
    if (workLimit !== null) {
      insert.run('agent.limits.workMaxIterations', JSON.stringify(workLimit), 3);
    }
    database.migrate();
    expect(database.currentVersion()).toBe(7);
    const limit = database.sqlite.prepare('SELECT value_json, updated_at FROM settings WHERE key = ?')
      .get('agent.limits.maxIterations');
    expect(limit).toEqual(workLimit === null ? undefined : { value_json: String(workLimit), updated_at: 3 });
    expect(database.sqlite.prepare("SELECT key FROM settings WHERE key IN ('agent.limits.chatMaxIterations', 'agent.limits.workMaxIterations')").all())
      .toEqual([]);
    expect(database.sqlite.prepare('SELECT value_json FROM settings WHERE key = ?').get('agent.limits.maxConcurrentSubagents'))
      .toEqual({ value_json: '4' });
  });
});
