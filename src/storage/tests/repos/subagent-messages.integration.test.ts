// 验证子代理 Message 的持久化形态、分页顺序和旧数据迁移。
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { SubagentMessagesRepo } from '../../repos/data/subagent-messages.js';
import { SubagentsRepo } from '../../repos/data/subagents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('SubagentMessagesRepo', () => {
  let database: TestDatabase;
  let repo: SubagentMessagesRepo;

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
      VALUES ('session-a', 'Session A', 'D:/work', 1, 1)
    `).run();
    database.db.prepare(`
      INSERT INTO turns (
        id, session_id, trigger_type, session_mode, narrative_policy, status, created_at
      ) VALUES ('turn-a', 'session-a', 'userMessage', 'work', 'auto', 'running', 1)
    `).run();
    new SubagentsRepo(database.db).insert({
      id: 'subagent-a',
      sessionId: 'session-a',
      parentTurnId: 'turn-a',
      contextMode: 'subagent',
      createdAt: 1,
    });
    repo = new SubagentMessagesRepo(database.db);
  });

  afterEach(() => database.close());

  it('更新流式 Assistant 不改变 Message 的 id、sequence 或创建时间', () => {
    repo.insert({
      id: 'assistant', subagentId: 'subagent-a', role: 'assistant',
      blocksJson: '[{"type":"tool_use","id":"call-a"}]', createdAt: 2,
    });
    repo.updateBlocks('assistant', '[{"type":"text","text":"完成"}]');
    repo.markInterrupted('assistant');

    expect(repo.listAllForSubagent('subagent-a')).toMatchObject([{
      id: 'assistant', sequence: 1, created_at: 2, interrupted: 1,
      blocks_json: '[{"type":"text","text":"完成"}]',
    }]);
  });

  it('保留完整 Assistant blocks、User 工具结果和 Summary 覆盖游标', () => {
    const assistantBlocks = [
      { type: 'thinking', text: '分析' },
      { type: 'tool_use', id: 'call-a', name: 'Read', input: { path: 'a.ts' } },
    ];
    const resultBlocks = [{ type: 'tool_result', tool_use_id: 'call-a', content: 'ok' }];
    repo.insert({ id: 'prompt', subagentId: 'subagent-a', role: 'user', blocksJson: '"任务"', createdAt: 1 });
    repo.insert({
      id: 'assistant', subagentId: 'subagent-a', role: 'assistant',
      blocksJson: JSON.stringify(assistantBlocks), interrupted: true, createdAt: 2,
    });
    repo.insert({
      id: 'result', subagentId: 'subagent-a', role: 'user', kind: 'tool_results',
      blocksJson: JSON.stringify(resultBlocks), createdAt: 3,
    });
    repo.insert({
      id: 'summary', subagentId: 'subagent-a', role: 'user', kind: 'summary',
      blocksJson: '"摘要"', summarizedThroughMessageId: 'assistant', createdAt: 4,
    });

    const rows = repo.listAllForSubagent('subagent-a');
    expect(rows.map(row => [row.id, row.role, row.kind, row.sequence])).toEqual([
      ['prompt', 'user', 'normal', 1],
      ['assistant', 'assistant', 'normal', 2],
      ['result', 'user', 'tool_results', 3],
      ['summary', 'user', 'summary', 4],
    ]);
    expect(JSON.parse(rows[1]!.blocks_json)).toEqual(assistantBlocks);
    expect(rows[1]!.interrupted).toBe(1);
    expect(JSON.parse(rows[2]!.blocks_json)).toEqual(resultBlocks);
    expect(rows[3]!.summarized_through_message_id).toBe('assistant');
  });

  it('按 sequence 向旧消息分页，同毫秒消息不会跳过', () => {
    for (let index = 1; index <= 5; index += 1) {
      repo.insert({
        id: `message-${index}`, subagentId: 'subagent-a', role: 'assistant',
        blocksJson: '[]', createdAt: 1,
      });
    }

    const newest = repo.listPage('subagent-a', undefined, 2);
    expect(newest.rows.map(row => row.id)).toEqual(['message-4', 'message-5']);
    expect(newest.nextCursor).toBe(4);
    const middle = repo.listPage('subagent-a', newest.nextCursor!, 2);
    expect(middle.rows.map(row => row.id)).toEqual(['message-2', 'message-3']);
    expect(middle.nextCursor).toBe(2);
    const oldest = repo.listPage('subagent-a', middle.nextCursor!, 2);
    expect(oldest.rows.map(row => row.id)).toEqual(['message-1']);
    expect(oldest.nextCursor).toBeNull();
  });
});

describe('003 子代理消息迁移', () => {
  it('旧 Assistant 与独立 ToolResult 保留身份和顺序并变为 Message blocks', () => {
    const database = new Database({ memory: true, kind: 'data' });
    try {
      database.sqlite.exec(readFileSync(new URL('../../migrations/data/001_initial.sql', import.meta.url), 'utf8'));
      database.sqlite.exec(readFileSync(new URL('../../migrations/data/002_move_turn_usage_to_records.sql', import.meta.url), 'utf8'));
      database.sqlite.pragma('user_version = 2');
      database.sqlite.prepare(`
        INSERT INTO sessions (id, title, cwd, created_at, updated_at)
        VALUES ('session-a', 'Session A', 'D:/work', 1, 1)
      `).run();
      database.sqlite.prepare(`
        INSERT INTO turns (id, session_id, status, created_at)
        VALUES ('turn-a', 'session-a', 'running', 1)
      `).run();
      database.sqlite.prepare(`
        INSERT INTO agent_runs (id, session_id, parent_turn_id, context_mode, created_at, updated_at)
        VALUES ('subagent-a', 'session-a', 'turn-a', 'subagent', 1, 1)
      `).run();
      database.sqlite.prepare(`
        INSERT INTO agent_run_messages (id, agent_run_id, role, content_json, sequence, created_at)
        VALUES (?, 'subagent-a', ?, ?, ?, ?)
      `).run('assistant', 'assistant', '[{"type":"text","text":"hello"}]', 1, 2);
      database.sqlite.prepare(`
        INSERT INTO agent_run_messages (id, agent_run_id, role, content_json, sequence, created_at)
        VALUES (?, 'subagent-a', ?, ?, ?, ?)
      `).run('result', 'tool_result', '{"type":"tool_result","content":"ok"}', 2, 3);

      database.migrate();

      const rows = new SubagentMessagesRepo(database.sqlite).listAllForSubagent('subagent-a');
      expect(rows.map(row => [row.id, row.role, row.kind, row.sequence])).toEqual([
        ['assistant', 'assistant', 'normal', 1],
        ['result', 'user', 'tool_results', 2],
      ]);
      expect(JSON.parse(rows[0]!.blocks_json)).toEqual([{ type: 'text', text: 'hello' }]);
      expect(JSON.parse(rows[1]!.blocks_json)).toEqual([{ type: 'tool_result', content: 'ok' }]);
    } finally {
      database.close();
    }
  });
});
