import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryTasksRepo } from '../../src/repos/memory-tasks.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('N-005 MemoryTask 租约与原子状态转换', () => {
  let database: TestDatabase;
  let repo: MemoryTasksRepo;

  beforeEach(() => {
    database = createTestDatabase();
    database.db.prepare(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES ('session-a', 'Session A', 1, 1)
    `).run();
    repo = new MemoryTasksRepo(database.db);
  });

  afterEach(() => database.close());

  function enqueue(id: string, createdAt: number): void {
    repo.enqueue({
      id,
      kind: 'extraction',
      sessionId: 'session-a',
      payload: { sessionId: 'session-a', mode: 'chat' },
      createdAt,
    });
  }

  it('失败重试在一条原子 UPDATE 中按 attempts 决定终态', () => {
    enqueue('task-retry', 10);

    for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
      const claimed = repo.claimNext(10 + expectedAttempt);
      expect(claimed?.attempts).toBe(expectedAttempt);

      const result = repo.markFailed(
        'task-retry',
        expectedAttempt,
        `failure-${expectedAttempt}`,
        20 + expectedAttempt,
        3,
      );
      expect(result?.status).toBe(expectedAttempt === 3 ? 'failed' : 'pending');
    }

    expect(repo.findById('task-retry')).toMatchObject({
      status: 'failed',
      attempts: 3,
      last_error: 'failure-3',
    });
  });

  it('任务被回收并重新认领后，旧执行代次不能心跳或收尾', () => {
    enqueue('task-fenced', 100);
    expect(repo.claimNext(110)).toMatchObject({ attempts: 1, status: 'running' });

    expect(repo.requeueExpiredRunning(110, 200)).toBe(1);
    expect(repo.claimNext(210)).toMatchObject({ attempts: 2, status: 'running' });

    expect(repo.heartbeat('task-fenced', 1, 220)).toBe(false);
    expect(repo.markCompleted('task-fenced', 1, 220)).toBeUndefined();
    expect(repo.markFailed('task-fenced', 1, 'late error', 220)).toBeUndefined();
    expect(repo.markCompleted('task-fenced', 2, 230)).toMatchObject({
      status: 'completed',
      attempts: 2,
    });
  });

  it('持续心跳的长任务不会因总运行时间长而被回收', () => {
    enqueue('task-long', 1);
    expect(repo.claimNext(100)).toBeDefined();

    expect(repo.heartbeat('task-long', 1, 1_000_000)).toBe(true);
    expect(repo.requeueExpiredRunning(999_999, 2_000_000)).toBe(0);
    expect(repo.findById('task-long')?.status).toBe('running');
  });

  it('独占启动恢复可以立即重置旧进程遗留的 running 任务', () => {
    enqueue('task-startup', 1);
    expect(repo.claimNext(2)).toBeDefined();

    expect(repo.recoverRunningAfterExclusiveStartup(3)).toBe(1);
    expect(repo.findById('task-startup')).toMatchObject({
      status: 'pending',
      attempts: 1,
      updated_at: 3,
    });
  });

  it('终态清理同时覆盖 completed 和 failed，并严格限制单批数量', () => {
    for (const [id, createdAt] of [
      ['completed-old', 1],
      ['failed-old', 2],
      ['completed-new', 3],
      ['pending-old', 4],
    ] as const) enqueue(id, createdAt);

    expect(repo.claimNext(10)?.id).toBe('completed-old');
    expect(repo.markCompleted('completed-old', 1, 11)).toBeDefined();
    expect(repo.claimNext(12)?.id).toBe('failed-old');
    expect(repo.markFailed('failed-old', 1, 'fatal', 13, 1)?.status).toBe('failed');
    expect(repo.claimNext(14)?.id).toBe('completed-new');
    expect(repo.markCompleted('completed-new', 1, 100)).toBeDefined();

    expect(repo.deleteTerminal(50, 1)).toBe(1);
    expect(repo.deleteTerminal(50, 1)).toBe(1);
    expect(repo.findById('completed-old')).toBeUndefined();
    expect(repo.findById('failed-old')).toBeUndefined();
    expect(repo.findById('completed-new')?.status).toBe('completed');
    expect(repo.findById('pending-old')?.status).toBe('pending');
  });
});
