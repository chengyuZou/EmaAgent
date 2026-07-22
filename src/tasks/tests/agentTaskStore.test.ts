import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, AgentTasksRepo } from '@ema-agent/storage';
import { AgentTaskStore } from '../agentTaskStore.js';

describe('AgentTaskStore CAS Facade', () => {
  let database: Database;
  let store: AgentTaskStore;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'data' });
    database.migrate();
    database.sqlite.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES ('session-a', 'Session A', 1, 1)
    `).run();
    store = new AgentTaskStore(new AgentTasksRepo(database.sqlite));
    store.claim({
      taskId: 'task-a',
      sessionId: 'session-a',
      turnId: null,
      parentId: null,
    });
  });

  afterEach(() => database.close());

  it('返回可判别的冲突结果且不覆盖 cancelled', () => {
    expect(store.cancel('task-a', 'user_abort')).toMatchObject({
      ok: true,
      changed: true,
      task: { status: 'cancelled', version: 1 },
    });

    expect(store.complete('task-a', {
      iterations: 1,
      inputTokens: 1,
      outputTokens: 1,
    })).toMatchObject({
      ok: false,
      reason: 'conflict',
      action: 'complete',
      current: { status: 'cancelled', version: 1 },
    });
  });

  it('相同终态重复提交是幂等重放', () => {
    expect(store.complete('task-a', {
      iterations: 1,
      inputTokens: 2,
      outputTokens: 3,
    })).toMatchObject({ ok: true, changed: true });

    expect(store.complete('task-a', {
      iterations: 99,
      inputTokens: 99,
      outputTokens: 99,
    })).toMatchObject({
      ok: true,
      changed: false,
      task: { status: 'completed', version: 1 },
    });
  });

  it('不存在的任务返回 not_found', () => {
    expect(store.cancel('missing', 'user_abort')).toEqual({
      ok: false,
      reason: 'not_found',
      action: 'cancel',
    });
  });
});
