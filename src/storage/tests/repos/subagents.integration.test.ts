// 验证身份与 Run 的事务同步、单运行约束、Cursor 和不携带统计的身份列表.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { SubagentMessagesRepo } from '../../repos/data/subagent-messages.js';
import { SubagentsRepo } from '../../repos/data/subagents.js';
import { SubagentRunsRepo } from '../../repos/data/subagentRuns.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('Subagent 身份与 Run', () => {
  let database: TestDatabase;
  let identities: SubagentsRepo;
  let runs: SubagentRunsRepo;
  const subagentId = 'subagent-a';
  const completion = {
    iterations: 3, toolCallCount: 5, inputTokens: 5_000, outputTokens: 20, finalText: '完成',
  };
  const configuration = {
    providerId: 'provider-a', modelId: 'model-a', protocol: 'openai-llm',
    permissionMode: 'default' as const, reasoningEffort: 'high' as const,
  };

  beforeEach(() => {
    database = createTestDatabase();
    database.db.exec(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
      VALUES ('session-a', 'Session A', 'D:/work', 1, 1);
      INSERT INTO turns (id, session_id, trigger_type, session_mode, status, created_at)
      VALUES ('turn-a', 'session-a', 'userMessage', 'work', 'running', 2);
    `);
    identities = new SubagentsRepo(database.db);
    runs = new SubagentRunsRepo(database.db);
    database.db.transaction(() => {
      identities.insert({
        id: subagentId, sessionId: 'session-a', title: '持久化调查', description: '熟悉子代理存储', createdAt: 3,
      });
      return runs.insert({
        id: 'run-a', subagentId, parentToolCallId: 'call-a', contextMode: 'subagent', description: '第一轮调研', createdAt: 3,
      });
    })();
  });

  afterEach(() => database.close());

  it('两个首次 insert 各自只写自己的表, 外层事务由调用方组合', () => {
    const firstRun = database.db.transaction(() => {
      const identity = identities.insert({
        id: 'subagent-b', sessionId: 'session-a', title: '新任务', description: '新任务描述', createdAt: 4,
      });
      expect(identity).toMatchObject({ id: 'subagent-b', title: '新任务', status: 'running', updated_at: 4 });
      expect(runs.findLatestRun('subagent-b')).toBeUndefined();
      const run = runs.insert({ id: 'run-b', subagentId: 'subagent-b', contextMode: 'subagent', createdAt: 5 });
      expect(identities.findById('subagent-b')).toEqual(identity);
      return run;
    })();
    expect(firstRun).toMatchObject({ id: 'run-b', subagent_id: 'subagent-b', status: 'running', created_at: 5 });
    expect(runs.findById('run-b')).toEqual(firstRun);
  });

  it('调用方的外层事务遇到重复身份时直接报错, 不插入首个 Run 或覆盖身份', () => {
    const before = identities.findById(subagentId);
    expect(() => database.db.transaction(() => {
      identities.insert({
        id: subagentId, sessionId: 'session-a', title: '不应覆盖', description: '不应更新', createdAt: 4,
      });
      return runs.insert({ id: 'run-b', subagentId, contextMode: 'subagent', createdAt: 4 });
    })()).toThrow(/UNIQUE constraint failed/);
    expect(identities.findById(subagentId)).toEqual(before);
    expect(runs.findById('run-b')).toBeUndefined();
  });

  it('配置和状态同步身份, 统计与结果只属于独立 Run', () => {
    runs.setRunConfiguration('run-a', configuration, 4);
    expect(runs.completeRun('run-a', completion, 5)).toMatchObject({
      id: 'run-a', subagent_id: subagentId, status: 'completed', provider_id: 'provider-a',
      model_id: 'model-a', protocol: 'openai-llm', permission_mode: 'default', reasoning_effort: 'high',
      iterations: 3, tool_call_count: 5, input_tokens: 5_000, completed_at: 5,
    });
    const completedRun = runs.findById('run-a')!;
    expect(completedRun.completed_at! - completedRun.created_at).toBe(2);
    expect(completedRun).not.toHaveProperty('duration_ms');
    const identity = identities.findById(subagentId);
    expect(identity).toEqual({
      id: subagentId, session_id: 'session-a', title: '持久化调查', description: '熟悉子代理存储',
      provider_id: 'provider-a', model_id: 'model-a', protocol: 'openai-llm',
      permission_mode: 'default', reasoning_effort: 'high', status: 'completed', created_at: 3, updated_at: 5,
    });
    for (const field of ['iterations', 'tool_call_count', 'input_tokens', 'output_tokens', 'duration_ms', 'final_text', 'context_mode', 'latest_run_id']) {
      expect(identity).not.toHaveProperty(field);
    }
    expect(identities.listForSession('session-a')).toEqual({ items: [identity], nextCursor: null });
  });

  it('另一个连接也不能同时开始相同子代理, 忙碌不更新身份资料', () => {
    const before = identities.findById(subagentId);
    const connection = new Database({ path: database.db.name, kind: 'data' });
    try {
      const other = new SubagentRunsRepo(connection.sqlite);
      expect(other.startRun(
        { id: 'run-b', subagentId, contextMode: 'subagent', createdAt: 4 },
        { title: '不应出现', description: '不应更新' },
      )).toBeUndefined();
      expect(other.findById('run-b')).toBeUndefined();
      expect(runs.findRunningRun(subagentId)?.id).toBe('run-a');
      expect(identities.findById(subagentId)).toEqual(before);
      expect(() => connection.sqlite.prepare(`
        INSERT INTO subagent_runs (id, subagent_id, context_mode, created_at, updated_at)
        VALUES ('run-c', ?, 'subagent', 4, 4)
      `).run(subagentId)).toThrow(/UNIQUE constraint failed/);
    } finally {
      connection.close();
    }
  });

  it('继续时保留身份资料和上次配置, 显式修改后才更新 Title 与 description', () => {
    runs.setRunConfiguration('run-a', configuration, 4);
    runs.completeRun('run-a', completion, 5);
    expect(runs.startRun({
      id: 'run-b', subagentId, parentToolCallId: 'call-b', contextMode: 'subagent', description: '实施', createdAt: 6,
    })).toMatchObject({ status: 'running', provider_id: null });
    expect(identities.findById(subagentId)).toMatchObject({
      title: '持久化调查', description: '熟悉子代理存储', status: 'running',
      provider_id: 'provider-a', model_id: 'model-a', reasoning_effort: 'high', updated_at: 6,
    });
    runs.setRunConfiguration('run-b', {
      providerId: 'provider-b', modelId: 'model-b', protocol: 'anthropic-llm',
      permissionMode: 'acceptEdits', reasoningEffort: 'medium',
    }, 7);
    runs.completeRun('run-b', { ...completion, toolCallCount: 3, inputTokens: 2_000 }, 8);
    expect(runs.findById('run-a')).toMatchObject({ input_tokens: 5_000, provider_id: 'provider-a' });
    expect(runs.findById('run-b')).toMatchObject({ input_tokens: 2_000, provider_id: 'provider-b' });
    expect(runs.listForSubagent(subagentId).items.map(run => run.id)).toEqual(['run-b', 'run-a']);
    runs.startRun(
      { id: 'run-c', subagentId, contextMode: 'subagent', createdAt: 9 },
      { title: '持久化修复', description: '继续处理回滚与恢复' },
    );
    expect(identities.findById(subagentId)).toMatchObject({
      title: '持久化修复', description: '继续处理回滚与恢复', created_at: 3, updated_at: 9,
      provider_id: 'provider-b', permission_mode: 'acceptEdits', reasoning_effort: 'medium',
    });
  });

  it('相同毫秒的后一次 Run 按实际插入顺序读取, 不依赖随机 ID 大小', () => {
    runs.cancelRun('run-a', 'cancelled', 3);
    runs.startRun({ id: 'run-0', subagentId, contextMode: 'subagent', createdAt: 3 });
    expect(runs.findLatestRun(subagentId)?.id).toBe('run-0');
    expect(runs.listForSubagent(subagentId).items.map(run => run.id)).toEqual(['run-a', 'run-0']);
  });

  it('旧 Run 的迟到结果或配置不改写身份当前状态和新 Run', () => {
    runs.setRunConfiguration('run-a', configuration, 4);
    runs.cancelRun('run-a', 'user_abort', 5);
    runs.startRun({ id: 'run-b', subagentId, contextMode: 'subagent', createdAt: 6 });
    const before = identities.findById(subagentId);
    expect(runs.completeRun('run-a', completion, 7)).toBeUndefined();
    expect(runs.setRunConfiguration('run-a', {
      ...configuration, providerId: 'late', modelId: 'late', permissionMode: 'bypassPermissions',
    }, 7)).toBeUndefined();
    expect(runs.failRun('run-a', 'late failure', 7)).toBeUndefined();
    expect(identities.findById(subagentId)).toEqual(before);
    expect(runs.findById('run-a')).toMatchObject({ status: 'cancelled', error: 'user_abort', provider_id: 'provider-a' });
    expect(runs.findById('run-b')).toMatchObject({ status: 'running', final_text: null });
  });

  it('调用方的外层事务在首个 Run 插入失败时回滚身份, 不吞父 ToolCall 冲突', () => {
    expect(() => database.db.transaction(() => {
      identities.insert({
        id: 'subagent-b', sessionId: 'session-a', title: '新任务', description: '新任务描述', createdAt: 4,
      });
      return runs.insert({
        id: 'run-b', subagentId: 'subagent-b', parentToolCallId: 'call-a', contextMode: 'fork', createdAt: 4,
      });
    })()).toThrow(/UNIQUE constraint failed/);
    expect(identities.findById('subagent-b')).toBeUndefined();
    expect(runs.findById('run-b')).toBeUndefined();
  });

  it('身份写入失败时配置、终态和开始执行的 Run 写入一起回滚', () => {
    const beforeRun = runs.findById('run-a');
    const beforeIdentity = identities.findById(subagentId);
    database.db.exec(`
      CREATE TRIGGER reject_identity_update BEFORE UPDATE ON subagents
      BEGIN SELECT RAISE(ABORT, 'test_identity_write_failed'); END;
    `);
    expect(() => runs.setRunConfiguration('run-a', configuration, 4)).toThrow('test_identity_write_failed');
    expect(() => runs.completeRun('run-a', completion, 4)).toThrow('test_identity_write_failed');
    expect(() => runs.failRun('run-a', 'failed', 4)).toThrow('test_identity_write_failed');
    expect(() => runs.markStuckRunsFailed(4)).toThrow('test_identity_write_failed');
    expect(runs.findById('run-a')).toEqual(beforeRun);
    expect(identities.findById(subagentId)).toEqual(beforeIdentity);
    database.db.exec('DROP TRIGGER reject_identity_update');
    runs.cancelRun('run-a', 'cancelled', 4);
    database.db.exec(`
      CREATE TRIGGER reject_identity_update BEFORE UPDATE ON subagents
      BEGIN SELECT RAISE(ABORT, 'test_identity_write_failed'); END;
    `);
    expect(() => runs.startRun({ id: 'run-b', subagentId, contextMode: 'subagent', createdAt: 5 }))
      .toThrow('test_identity_write_failed');
    expect(runs.findById('run-b')).toBeUndefined();
    expect(identities.findById(subagentId)).toMatchObject({ status: 'cancelled', updated_at: 4 });
  });

  it('异常退出只收口 running Run, 并同步身份, 无父调用不伪造 ToolCallId', () => {
    runs.failRun('run-a', 'prepare failed', 4);
    runs.startRun({ id: 'run-b', subagentId, contextMode: 'subagent', createdAt: 5 });
    expect(runs.listRunningRuns().map(row => row.id)).toEqual(['run-b']);
    expect(runs.markStuckRunsFailed(6)).toMatchObject([{
      id: 'run-b', parent_tool_call_id: null, status: 'failed', error: 'Process terminated unexpectedly',
    }]);
    expect(identities.findById(subagentId)).toMatchObject({ status: 'failed', updated_at: 6 });
    expect(runs.findById('run-a')?.error).toBe('prepare failed');
    expect(runs.startRun({ id: 'run-c', subagentId, contextMode: 'subagent', createdAt: 7 })?.status).toBe('running');
  });

  it('删除父 Turn 不删除子代理, 删除 Session 才级联删除三层历史', () => {
    const messages = new SubagentMessagesRepo(database.db);
    messages.insert({ id: 'message-a', subagentId, runId: 'run-a', role: 'user', blocksJson: '"任务"', createdAt: 4 });
    database.db.prepare('DELETE FROM turns WHERE id = ?').run('turn-a');
    expect(identities.findById(subagentId)).toBeDefined();
    expect(runs.findById('run-a')).toBeDefined();
    expect(messages.listAllForSubagent(subagentId)).toHaveLength(1);
    database.db.prepare('DELETE FROM sessions WHERE id = ?').run('session-a');
    expect(identities.findById(subagentId)).toBeUndefined();
    expect(runs.findById('run-a')).toBeUndefined();
    expect(messages.listAllForSubagent(subagentId)).toEqual([]);
    expect(database.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('终态清理不会删除已经开启下一次 Run 的身份', () => {
    runs.completeRun('run-a', completion, 4);
    runs.startRun({ id: 'run-b', subagentId, contextMode: 'subagent', createdAt: 5 });
    expect(identities.deleteTerminalForSession('session-a')).toBe(0);
    runs.cancelRun('run-b', 'cancelled', 6);
    expect(identities.deleteTerminalForSession('session-a')).toBe(1);
    expect(runs.listForSubagent(subagentId)).toEqual({ items: [], nextCursor: null });
  });

  it('身份列表按更新时间与 ID 游标分页, 同刻记录不跳过且不混入别的 Session', () => {
    database.db.prepare(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('session-b', 'B', '/work', 1, 1)
    `).run();
    for (const id of ['subagent-b', 'subagent-c', 'subagent-d']) {
      database.db.transaction(() => {
        identities.insert({ id, sessionId: 'session-a', title: id, description: '目录描述', createdAt: 3 });
        return runs.insert({ id: `run-${id}`, subagentId: id, contextMode: 'subagent', createdAt: 3 });
      })();
    }
    database.db.transaction(() => {
      identities.insert({ id: 'other', sessionId: 'session-b', title: '其他会话', description: '不混入', createdAt: 100 });
      return runs.insert({ id: 'run-other', subagentId: 'other', contextMode: 'fork', createdAt: 100 });
    })();
    runs.completeRun('run-a', completion, 4);
    const first = identities.listForSession('session-a', undefined, 2);
    expect(first.items.map(row => row.id)).toEqual(['subagent-a', 'subagent-d']);
    expect(first.nextCursor).toEqual({ updatedAt: 3, id: 'subagent-d' });
    const second = identities.listForSession('session-a', first.nextCursor!, 2);
    expect(second.items.map(row => row.id)).toEqual(['subagent-c', 'subagent-b']);
    expect(second.nextCursor).toBeNull();
    expect(identities.listForSession('session-a', { updatedAt: 3, id: 'subagent-b' }, 2))
      .toEqual({ items: [], nextCursor: null });
    expect(identities.listForSession('missing')).toEqual({ items: [], nextCursor: null });
  });

  it('Run 列表按创建时间与 ID 分页, 同刻记录和翻页间新增执行不造成漏项', () => {
    runs.cancelRun('run-a', 'cancelled', 4);
    for (const id of ['run-b', 'run-c', 'run-d']) {
      runs.startRun({ id, subagentId, contextMode: 'subagent', createdAt: 5 });
      runs.completeRun(id, completion, 5);
    }
    database.db.transaction(() => {
      identities.insert({ id: 'other', sessionId: 'session-a', title: '其他子代理', description: '不混入', createdAt: 100 });
      return runs.insert({ id: 'other-run', subagentId: 'other', contextMode: 'subagent', createdAt: 100 });
    })();
    const first = runs.listForSubagent(subagentId, undefined, 2);
    expect(first.items.map(row => row.id)).toEqual(['run-d', 'run-c']);
    expect(first.items.every(row => row.completed_at! - row.created_at === 0)).toBe(true);
    expect(first.nextCursor).toEqual({ createdAt: 5, id: 'run-c' });
    runs.startRun({ id: 'run-new', subagentId, contextMode: 'subagent', createdAt: 6 });
    const second = runs.listForSubagent(subagentId, first.nextCursor!, 2);
    expect(second.items.map(row => row.id)).toEqual(['run-b', 'run-a']);
    expect(second.nextCursor).toBeNull();
    expect(runs.listForSubagent(subagentId, { createdAt: 3, id: 'run-a' }, 2))
      .toEqual({ items: [], nextCursor: null });
    expect(runs.listForSubagent('missing')).toEqual({ items: [], nextCursor: null });
  });
});
