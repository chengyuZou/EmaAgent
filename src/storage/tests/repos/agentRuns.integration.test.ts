// 验证 AgentRun 的父 Turn 归属、CAS 终态和异常退出恢复。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asAgentRunId,
  asSessionId,
  asTurnId,
} from '@ema-agent/ids';
import { AgentRunsRepo } from '../../repos/data/agent-runs.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('AgentRun 持久化状态机', () => {
  let database: TestDatabase;
  let repo: AgentRunsRepo;
  const agentRunId = asAgentRunId('run-a');

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES ('session-a', 'Session A', 1, 1)
    `).run();
    database.db.prepare(`
      INSERT INTO turns (
        id, session_id, trigger_type, execution_profile, narrative_policy,
        status, user_input, started_at
      ) VALUES ('turn-a', 'session-a', 'userMessage', 'work', 'auto', 'running', 'run', 2)
    `).run();

    repo = new AgentRunsRepo(database.db);
    repo.insert({
      id: agentRunId,
      sessionId: asSessionId('session-a'),
      parentTurnId: asTurnId('turn-a'),
      kind: 'subagent',
      createdAt: 3,
    });
  });

  afterEach(() => database.close());

  it('合法完成会记录执行统计并递增 version', () => {
    const completed = repo.complete(
      agentRunId,
      0,
      {
        iterations: 3,
        toolCallCount: 2,
        inputTokens: 10,
        outputTokens: 20,
        outputExcerpt: 'done',
      },
      4,
    );

    expect(completed).toMatchObject({
      status: 'completed',
      version: 1,
      iterations: 3,
      tool_call_count: 2,
      input_tokens: 10,
      output_tokens: 20,
      output_excerpt: 'done',
    });
  });

  it('取消获胜后迟到 Worker 不能覆盖终态', () => {
    expect(repo.cancel(agentRunId, 0, 'user_abort', 4)).toMatchObject({
      status: 'cancelled',
      version: 1,
    });

    expect(repo.complete(
      agentRunId,
      0,
      {
        iterations: 1,
        toolCallCount: 0,
        inputTokens: 1,
        outputTokens: 1,
      },
      5,
    )).toBeUndefined();
    expect(repo.findById(agentRunId)).toMatchObject({
      status: 'cancelled',
      error: 'user_abort',
      version: 1,
    });
  });

  it('异常退出会把 running 记录标为 failed', () => {
    expect(repo.markStuckFailed(4)).toEqual([
      expect.objectContaining({
        id: agentRunId,
        status: 'failed',
        version: 1,
      }),
    ]);
  });
});
