// 验证子代理与主 Message 相同的内容字段、时间/ID Cursor、摘要边界与 fork 来源.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { SubagentMessagesRepo } from '../../repos/data/subagent-messages.js';
import { SubagentRunsRepo } from '../../repos/data/subagentRuns.js';
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
    const identities = new SubagentsRepo(database.db);
    const runs = new SubagentRunsRepo(database.db);
    database.db.transaction(() => {
      identities.insert({ id: 'subagent-a', sessionId: 'session-a', title: '调研', description: '调查业务结构', createdAt: 1 });
      return runs.insert({ id: 'run-a', subagentId: 'subagent-a', parentToolCallId: 'call-a', contextMode: 'subagent', createdAt: 1 });
    })();
    repo = new SubagentMessagesRepo(database.db);
  });

  afterEach(() => database.close());

  it('更新流式 Assistant 不改变 Message 的 id 或创建时间, 不存 sequence', () => {
    repo.insert({
      id: 'assistant', subagentId: 'subagent-a', runId: 'run-a', role: 'assistant',
      blocksJson: '[{"type":"tool_use","id":"call-a"}]', createdAt: 2,
    });
    repo.updateBlocks('assistant', '[{"type":"text","text":"完成"}]');
    repo.markInterrupted('assistant');

    expect(repo.listAllForSubagent('subagent-a')).toMatchObject([{
      id: 'assistant', created_at: 2, interrupted: 1,
      blocks_json: '[{"type":"text","text":"完成"}]',
    }]);
    expect(repo.listAllForSubagent('subagent-a')[0]).not.toHaveProperty('sequence');
  });

  it('保留完整 Assistant blocks、User 工具结果和 Summary 覆盖游标', () => {
    const assistantBlocks = [
      { type: 'thinking', thinking: '分析', signature: 'native-signature' },
      { type: 'tool_use', id: 'call-a', name: 'Read', args: { path: 'a.ts' } },
    ];
    const resultBlocks = [{ type: 'tool_result', toolCallId: 'call-a', content: 'ok' }];
    repo.insert({ id: 'prompt', subagentId: 'subagent-a', runId: 'run-a', role: 'user', blocksJson: '"任务"', createdAt: 1 });
    repo.insert({
      id: 'assistant', subagentId: 'subagent-a', runId: 'run-a', role: 'assistant',
      blocksJson: JSON.stringify(assistantBlocks), interrupted: true, createdAt: 2,
    });
    repo.insert({
      id: 'result', subagentId: 'subagent-a', runId: 'run-a', role: 'user', kind: 'tool_results',
      blocksJson: JSON.stringify(resultBlocks), createdAt: 3,
    });
    repo.insert({
      id: 'summary', subagentId: 'subagent-a', runId: 'run-a', role: 'user', kind: 'summary',
      blocksJson: '"摘要"', summarizedThroughMessageId: 'assistant', savedTokens: 1_234, createdAt: 4,
    });

    const rows = repo.listAllForSubagent('subagent-a');
    expect(rows.map(row => [row.id, row.role, row.kind])).toEqual([
      ['prompt', 'user', 'normal'],
      ['assistant', 'assistant', 'normal'],
      ['result', 'user', 'tool_results'],
      ['summary', 'user', 'summary'],
    ]);
    expect(JSON.parse(rows[1]!.blocks_json)).toEqual(assistantBlocks);
    expect(rows[1]!.interrupted).toBe(1);
    expect(JSON.parse(rows[2]!.blocks_json)).toEqual(resultBlocks);
    expect(rows[3]!.summarized_through_message_id).toBe('assistant');
    expect(rows[3]!.summary_saved_tokens).toBe(1_234);
    expect(rows[0]!.summary_saved_tokens).toBeNull();
  });

  it('复用主 Message 的时间/ID Cursor, 同毫秒翻页不跳过且页内正序', () => {
    for (let index = 1; index <= 5; index += 1) {
      repo.insert({
        id: `message-${index}`, subagentId: 'subagent-a', runId: 'run-a', role: 'assistant',
        blocksJson: '[]', createdAt: 1,
      });
    }

    const newest = repo.listPage('subagent-a', undefined, 2);
    expect(newest.rows.map(row => row.id)).toEqual(['message-4', 'message-5']);
    expect(newest.nextCursor).toEqual({ createdAt: 1, id: 'message-4' });
    const middle = repo.listPage('subagent-a', newest.nextCursor!, 2);
    expect(middle.rows.map(row => row.id)).toEqual(['message-2', 'message-3']);
    expect(middle.nextCursor).toEqual({ createdAt: 1, id: 'message-2' });
    const oldest = repo.listPage('subagent-a', middle.nextCursor!, 2);
    expect(oldest.rows.map(row => row.id)).toEqual(['message-1']);
    expect(oldest.nextCursor).toBeNull();
    expect(repo.listPage('missing', undefined)).toEqual({ rows: [], nextCursor: null });
  });
  it('fork 前缀保留独立来源, 自身 Assistant 从实际 Run 取得来源', () => {
    const runs = new SubagentRunsRepo(database.db);
    runs.setRunConfiguration('run-a', {
      providerId: 'child-provider', modelId: 'child-model', protocol: 'anthropic-llm',
      permissionMode: 'default', reasoningEffort: 'high',
    }, 2);
    const blocks = [{ type: 'reasoning', id: 'native-item', encryptedContent: 'native-encrypted' }];
    repo.insertMany([
      {
        id: 'prefix', subagentId: 'subagent-a', runId: null, role: 'assistant',
        blocksJson: JSON.stringify(blocks), createdAt: 2,
        providerId: 'parent-provider', modelId: 'parent-model', protocol: 'openai-llm',
      },
      { id: 'own', subagentId: 'subagent-a', runId: 'run-a', role: 'assistant', blocksJson: '[]', createdAt: 3 },
      { id: 'input', subagentId: 'subagent-a', runId: 'run-a', role: 'user', blocksJson: '"继续"', createdAt: 4 },
    ]);
    expect(repo.listAllForSubagent('subagent-a')).toMatchObject([
      { id: 'prefix', run_id: null, provider_id: 'parent-provider', model_id: 'parent-model', protocol: 'openai-llm' },
      { id: 'own', run_id: 'run-a', provider_id: 'child-provider', model_id: 'child-model', protocol: 'anthropic-llm' },
      { id: 'input', run_id: 'run-a', provider_id: null, model_id: null, protocol: null },
    ]);
    expect(JSON.parse(repo.listPage('subagent-a', undefined).rows[0]!.blocks_json)).toEqual(blocks);
    expect(database.db.prepare('SELECT provider_id, model_id, protocol FROM subagent_messages WHERE id = ?').get('own'))
      .toEqual({ provider_id: null, model_id: null, protocol: null });
  });

  it('后续 Run 沿用连续消息历史, 多次摘要不吞掉写入较早的未覆盖消息', () => {
    const runs = new SubagentRunsRepo(database.db);
    repo.insertMany([
      { id: 'a', subagentId: 'subagent-a', runId: 'run-a', role: 'user', blocksJson: '"A"', createdAt: 2 },
      { id: 'b', subagentId: 'subagent-a', runId: 'run-a', role: 'user', blocksJson: '"B"', createdAt: 3 },
      { id: 's1', subagentId: 'subagent-a', runId: 'run-a', role: 'user', kind: 'summary', blocksJson: '"Summary"', summarizedThroughMessageId: 'a', createdAt: 4 },
    ]);
    expect(repo.listForSubagentFromSummary('subagent-a').map(row => row.id)).toEqual(['s1', 'b']);
    runs.cancelRun('run-a', 'done', 5);
    runs.startRun({ id: 'run-b', subagentId: 'subagent-a', contextMode: 'subagent', createdAt: 6 });
    repo.insert({ id: 'c', subagentId: 'subagent-a', runId: 'run-b', role: 'user', blocksJson: '"继续"', createdAt: 6 });
    expect(repo.listAllForSubagent('subagent-a').map(row => row.id)).toEqual(['a', 'b', 's1', 'c']);
    expect(repo.listForSubagentFromSummary('subagent-a').map(row => row.id)).toEqual(['s1', 'b', 'c']);
    repo.insert({ id: 's2', subagentId: 'subagent-a', runId: 'run-b', role: 'user', kind: 'summary', blocksJson: '"再摘要"', summarizedThroughMessageId: 's1', createdAt: 7 });
    expect(repo.listForSubagentFromSummary('subagent-a').map(row => row.id)).toEqual(['s2', 'b', 'c']);
  });

  it('前缀批量写入失败全部回滚, 不留下部分初始化消息', () => {
    expect(() => repo.insertMany([
      { id: 'same', subagentId: 'subagent-a', runId: null, role: 'user', blocksJson: '"前缀"', createdAt: 2 },
      { id: 'same', subagentId: 'subagent-a', runId: 'run-a', role: 'user', blocksJson: '"任务"', createdAt: 3 },
    ])).toThrow(/UNIQUE constraint failed/);
    expect(repo.listAllForSubagent('subagent-a')).toEqual([]);
  });

  it('SQL 拒绝把别的子代理 Run 关联到本子代理消息', () => {
    const identities = new SubagentsRepo(database.db);
    const runs = new SubagentRunsRepo(database.db);
    database.db.transaction(() => {
      identities.insert({ id: 'subagent-b', sessionId: 'session-a', title: '实施', description: '处理实现', createdAt: 2 });
      return runs.insert({ id: 'run-b', subagentId: 'subagent-b', contextMode: 'fork', createdAt: 2 });
    })();
    expect(() => repo.insert({
      id: 'wrong', subagentId: 'subagent-a', runId: 'run-b', role: 'user', blocksJson: '"任务"', createdAt: 3,
    })).toThrow(/ownership_violation/);
    expect(repo.listAllForSubagent('subagent-a')).toEqual([]);
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
      expect(rows.map(row => [row.id, row.role, row.kind])).toEqual([
        ['assistant', 'assistant', 'normal'],
        ['result', 'user', 'tool_results'],
      ]);
      expect(JSON.parse(rows[0]!.blocks_json)).toEqual([{ type: 'text', text: 'hello' }]);
      expect(JSON.parse(rows[1]!.blocks_json)).toEqual([{ type: 'tool_result', content: 'ok' }]);
    } finally {
      database.close();
    }
  });
});
