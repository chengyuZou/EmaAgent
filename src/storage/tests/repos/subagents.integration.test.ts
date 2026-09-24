// 验证 Subagent 的父 Turn 归属、终态迁移守卫和异常退出恢复。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubagentsRepo } from '../../repos/data/subagents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('Subagent 持久化状态机', () => {
  let database: TestDatabase;
  let repo: SubagentsRepo;
  const subagentId = 'subagent-a';

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, cwd, created_at, updated_at)
      VALUES ('session-a', 'Session A', 'D:/work', 1, 1)
    `).run();
    database.db.prepare(`
      INSERT INTO turns (
        id, session_id, trigger_type, session_mode, narrative_policy,
        status, created_at
      ) VALUES ('turn-a', 'session-a', 'userMessage', 'work', 'auto', 'running', 2)
    `).run();

    repo = new SubagentsRepo(database.db);
    repo.insert({
      id: subagentId,
      sessionId: 'session-a',
      parentTurnId: 'turn-a',
      contextMode: 'subagent',
      createdAt: 3,
    });
  });

  afterEach(() => database.close());

  it('合法完成会记录执行统计', () => {
    const completed = repo.complete(
      subagentId,
      {
        iterations: 3,
        toolCallCount: 2,
        inputTokens: 10,
        outputTokens: 20,
        finalText: '完成',
      },
      4,
    );

    expect(completed).toMatchObject({
      status: 'completed',
      iterations: 3,
      tool_call_count: 2,
      input_tokens: 10,
      output_tokens: 20,
      completed_at: 4,
    });
  });

  it('取消获胜后迟到 Worker 不能覆盖终态', () => {
    expect(repo.cancel(subagentId, 'user_abort', 4)).toMatchObject({
      status: 'cancelled',
    });

    expect(repo.complete(
      subagentId,
      {
        iterations: 1,
        toolCallCount: 0,
        inputTokens: 1,
        outputTokens: 1,
        finalText: '迟到结果',
      },
      5,
    )).toBeUndefined();
    expect(repo.findById(subagentId)).toMatchObject({
      status: 'cancelled',
      error: 'user_abort',
    });
  });

  it('异常退出会把 running 记录标为 failed', () => {
    expect(repo.markStuckFailed(4)).toEqual([
      expect.objectContaining({
        id: subagentId,
        status: 'failed',
      }),
    ]);
  });
});
