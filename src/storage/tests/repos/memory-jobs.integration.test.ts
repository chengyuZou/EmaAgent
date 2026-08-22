// 验证文件式双轨 Memory Job 的迁移、认领、终态、重试、提取结果和路径占用。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryJobsRepo } from '../../repos/data/memory-jobs.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('MemoryJobsRepo', () => {
  let database: TestDatabase;
  let repo: MemoryJobsRepo;

  beforeEach(() => {
    database = createTestDatabase();
    repo = new MemoryJobsRepo(database.db);
    database.db.prepare(`
      INSERT INTO sessions(id, title, created_at, updated_at)
      VALUES ('session-a', 'Session A', 1, 1)
    `).run();
    database.db.prepare(`
      INSERT INTO turns(
        id, session_id, trigger_type, execution_profile,
        narrative_policy, status, created_at
      ) VALUES (
        'turn-a', 'session-a', 'userMessage', 'chat',
        'off', 'completed', 1
      )
    `).run();
    database.db.prepare(`
      INSERT INTO turns(
        id, session_id, trigger_type, execution_profile,
        narrative_policy, status, created_at
      ) VALUES (
        'turn-b', 'session-a', 'userMessage', 'chat',
        'off', 'completed', 2
      )
    `).run();
  });

  afterEach(() => database.close());

  it('001 基线只建立新三表，提取 Job 必须引用 Turn', () => {
    const tables = database.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%'`,
    ).all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'memory_jobs',
      'memory_extraction_results',
      'memory_job_paths',
    ]));
    expect(tables.some((row) => row.name === 'memory_tasks')).toBe(false);

    expect(() => repo.enqueue({
      id: 'missing-turn',
      kind: 'work_extraction',
      createdAt: 2,
    })).toThrow('requires turnId');

    expect(repo.enqueue({
      id: 'work-a',
      kind: 'work_extraction',
      turnId: 'turn-a',
      createdAt: 3,
    })).toMatchObject({ status: 'pending', turnId: 'turn-a' });
  });

  it('Extraction 可并行，两轨 consolidation 可并行，清理等待写者结束', () => {
    enqueue('extract-a', 'work_extraction', 1, 'turn-a');
    enqueue('extract-b', 'work_extraction', 2, 'turn-b');
    enqueue('work-consolidate', 'work_consolidation', 3);
    enqueue('relationship-consolidate', 'relationship_consolidation', 4);
    enqueue('clear', 'clear_memory', 5);

    expect(repo.claimNext('work_extraction', 10)?.id).toBe('extract-a');
    expect(repo.claimNext('work_extraction', 11)?.id).toBe('extract-b');
    expect(repo.claimNext('work_consolidation', 12)?.id).toBe('work-consolidate');
    expect(repo.claimNext('relationship_consolidation', 13)?.id)
      .toBe('relationship-consolidate');
    expect(repo.claimNext('clear_memory', 14)).toBeUndefined();

    expect(repo.complete('work-consolidate', 15)?.status).toBe('completed');
    expect(repo.complete('relationship-consolidate', 16)?.status).toBe('completed');
    expect(repo.claimNext('clear_memory', 17)?.id).toBe('clear');
  });

  it('提取正文与终态原子落库，整合只标记本轮消费的结果', () => {
    enqueue('relationship-a', 'relationship_extraction', 1, 'turn-a');
    expect(repo.claimNext('relationship_extraction', 2)?.status).toBe('running');
    expect(repo.completeExtraction('relationship-a', '角色关系候选', 3)?.status)
      .toBe('completed');

    expect(repo.listUnintegratedExtractionResults('relationship_extraction', 10))
      .toEqual([{
        jobId: 'relationship-a',
        kind: 'relationship_extraction',
        turnId: 'turn-a',
        content: '角色关系候选',
        integratedAt: null,
      }]);
    enqueue('relationship-consolidate', 'relationship_consolidation', 4);
    expect(repo.claimNext('relationship_consolidation', 5)?.status).toBe('running');
    expect(repo.completeConsolidation(
      'relationship-consolidate',
      ['relationship-a'],
      6,
    )?.status).toBe('completed');
    expect(repo.listUnintegratedExtractionResults('relationship_extraction', 10))
      .toEqual([]);
  });

  it('同一 Turn 同一轨反复入队只返回同一条有效 Job', () => {
    const first = repo.enqueue({
      id: 'work-first',
      kind: 'work_extraction',
      turnId: 'turn-a',
      createdAt: 1,
    });
    const duplicate = repo.enqueue({
      id: 'work-duplicate',
      kind: 'work_extraction',
      turnId: 'turn-a',
      createdAt: 2,
    });

    expect(duplicate.id).toBe(first.id);
    expect(repo.findById('work-duplicate')).toBeUndefined();
  });

  it('失败重试创建新 Job 并复制目标路径，取消和启动恢复阻止旧 Worker 收尾', () => {
    repo.enqueue({
      id: 'clear-old',
      kind: 'clear_memory',
      createdAt: 1,
    }, [{ relativePath: 'relationship/characters/ema', operation: 'delete_tree' }]);

    expect(repo.claimNext('clear_memory', 2)?.status).toBe('running');
    expect(repo.listBusyPaths()).toHaveLength(1);
    expect(repo.fail('clear-old', '用户文件占用', 3)?.status).toBe('failed');
    expect(repo.listBusyPaths()).toEqual([]);

    expect(repo.retry('clear-old', 'clear-new', 4)?.status).toBe('pending');
    expect(repo.listPaths('clear-new')).toEqual([{
      jobId: 'clear-new',
      relativePath: 'relationship/characters/ema',
      operation: 'delete_tree',
    }]);

    expect(repo.claimNext('clear_memory', 5)?.id).toBe('clear-new');
    expect(repo.cancel('clear-new', 6)?.status).toBe('cancelled');
    expect(repo.heartbeat('clear-new', 7)).toBe(false);
    expect(repo.complete('clear-new', 7)).toBeUndefined();

    enqueue('cleanup', 'storage_cleanup', 8);
    expect(repo.claimNext('storage_cleanup', 9)?.status).toBe('running');
    expect(repo.failInterruptedRunning(10)).toBe(1);
    expect(repo.findById('cleanup')).toMatchObject({
      status: 'failed',
      error: '上次运行被应用退出中断',
      finishedAt: 10,
    });
  });

  it('lastCompletedAt 只统计该轨整合 completed，从未成功返回 undefined', () => {
    // 从未整合：undefined（提取/维护的完成时间不能当作基准）。
    expect(repo.lastCompletedAt('work_consolidation')).toBeUndefined();
    expect(repo.lastCompletedAt('relationship_consolidation')).toBeUndefined();

    enqueue('wc-1', 'work_consolidation', 1);
    enqueue('wc-2', 'work_consolidation', 2);
    enqueue('rc-1', 'relationship_consolidation', 3);

    expect(repo.claimNext('work_consolidation', 10)?.id).toBe('wc-1');
    repo.fail('wc-1', '首次失败', 11);
    // failed 不算冷却基准（只有 completed 算）。
    expect(repo.lastCompletedAt('work_consolidation')).toBeUndefined();

    expect(repo.claimNext('work_consolidation', 12)?.id).toBe('wc-2');
    repo.complete('wc-2', 20);
    expect(repo.lastCompletedAt('work_consolidation')).toBe(20);

    // 其它 kind 不受影响：relationship 还没成功整合。
    expect(repo.lastCompletedAt('relationship_consolidation')).toBeUndefined();
    expect(repo.claimNext('relationship_consolidation', 30)?.id).toBe('rc-1');
    repo.complete('rc-1', 40);
    expect(repo.lastCompletedAt('relationship_consolidation')).toBe(40);
    // work 轨仍保留自己的时间，不被 relationship 覆盖。
    expect(repo.lastCompletedAt('work_consolidation')).toBe(20);
  });

  function enqueue(
    id: string,
    kind:
      | 'work_extraction'
      | 'relationship_extraction'
      | 'work_consolidation'
      | 'relationship_consolidation'
      | 'clear_memory'
      | 'storage_cleanup',
    createdAt: number,
    turnId?: string,
  ): void {
    repo.enqueue({ id, kind, createdAt, ...(turnId ? { turnId } : {}) });
  }
});
