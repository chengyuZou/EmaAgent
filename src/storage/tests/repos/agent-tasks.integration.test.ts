import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentTasksRepo } from '../../repos/agent-tasks.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('B-056 AgentTask CAS', () => {
  let database: TestDatabase;
  let repo: AgentTasksRepo;

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES ('session-a', 'Session A', 1, 1)
    `).run();
    repo = new AgentTasksRepo(database.db);
    repo.insert({
      id: 'task-a',
      sessionId: 'session-a',
      turnId: null,
      parentId: null,
      createdAt: 2,
    });
  });

  afterEach(() => database.close());

  it('每次合法转换都递增 version', () => {
    expect(repo.findById('task-a')?.version).toBe(0);

    const completed = repo.complete(
      'task-a',
      0,
      { iterations: 3, inputTokens: 10, outputTokens: 20 },
      3,
    );
    expect(completed).toMatchObject({
      status: 'completed',
      version: 1,
      iterations: 3,
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  it('取消获胜后旧 Worker 不能覆盖成 completed', () => {
    const cancelled = repo.cancel('task-a', 0, 'user_abort', 3);
    expect(cancelled).toMatchObject({ status: 'cancelled', version: 1 });

    const staleCompletion = repo.complete(
      'task-a',
      0,
      { iterations: 1, inputTokens: 1, outputTokens: 1 },
      4,
    );
    expect(staleCompletion).toBeUndefined();
    expect(repo.findById('task-a')).toMatchObject({
      status: 'cancelled',
      error: 'user_abort',
      version: 1,
    });
  });

  it('completed/failed/cancelled 终态不可逆', () => {
    expect(repo.complete(
      'task-a',
      0,
      { iterations: 1, inputTokens: 1, outputTokens: 1 },
      3,
    )).toBeDefined();

    expect(repo.fail('task-a', 1, 'late failure', 4)).toBeUndefined();
    expect(repo.cancel('task-a', 1, 'late cancel', 4)).toBeUndefined();
    expect(repo.findById('task-a')).toMatchObject({ status: 'completed', version: 1 });
  });

  it('崩溃恢复将 running 标为 failed 并递增 version', () => {
    const recovered = repo.markStuckFailed(3);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'failed',
      version: 1,
    });
  });
});
