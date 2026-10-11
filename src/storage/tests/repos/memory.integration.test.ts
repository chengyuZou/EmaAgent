import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRepo } from '../../repos/data/memory.js';
import { createTestDatabase, type TestDatabase } from '../helpers/create-test-database.js';

describe('MemoryRepo', () => {
  let database: TestDatabase;
  let repo: MemoryRepo;

  beforeEach(() => {
    database = createTestDatabase();
    repo = new MemoryRepo(database.db);
    database.db.prepare(`
      INSERT INTO sessions(id, title, cwd, created_at, updated_at)
      VALUES ('session-a', 'Session A', 'D:/work', 1, 1)
    `).run();
    for (const [id, at] of [['turn-a', 1], ['turn-b', 2]] as const) {
      database.db.prepare(`
        INSERT INTO turns(
          id, session_id, trigger_type, status, created_at
        ) VALUES (?, 'session-a', 'userMessage', 'completed', ?)
      `).run(id, at);
    }
  });

  afterEach(() => database.close());

  it('两条 Extraction 轨独立落表并独立统计 readiness', () => {
    repo.enqueueExtraction('work-job', 'work_extraction', 'turn-a', 10);
    repo.enqueueExtraction('relation-job', 'relationship_extraction', 'turn-b', 20);
    repo.claimNext('work_extraction', 30);
    repo.claimNext('relationship_extraction', 31);
    repo.completeWorkExtraction('work-job', 'session-a', '偏好', 40);
    repo.completeRelationshipExtraction('relation-job', 'session-a', '艾玛', '关系', 41);

    expect(repo.workReadiness()).toEqual({ count: 1, oldestCreatedAt: 10 });
    expect(repo.relationshipReadiness()).toEqual({ count: 1, oldestCreatedAt: 20 });
    expect(repo.listUnintegratedRelationship(10)[0]).toMatchObject({
      turnId: 'turn-b',
      sessionId: 'session-a',
      characterName: '艾玛',
      content: '关系',
    });
  });

  it('同轨 Consolidation 与 Maintenance 串行，不同轨可并行', () => {
    repo.enqueueConsolidationIfAbsent('work-c', 'work_consolidation', 1);
    expect(repo.claimNext('work_consolidation', 2)?.id).toBe('work-c');
    expect(repo.startMaintenanceIfIdle('work-m', 'work_maintenance', 3)).toBeUndefined();
    expect(repo.startMaintenanceIfIdle('relation-m', 'relationship_maintenance', 3)?.id)
      .toBe('relation-m');
  });

  it('Consolidation 只消费明确给出的 Turn', () => {
    for (const [turnId, jobId] of [['turn-a', 'work-a'], ['turn-b', 'work-b']] as const) {
      repo.enqueueExtraction(jobId, 'work_extraction', turnId, 1);
      repo.claimNext('work_extraction', 2);
      repo.completeWorkExtraction(jobId, 'session-a', turnId, 3);
    }
    repo.enqueueConsolidationIfAbsent('work-c', 'work_consolidation', 4);
    repo.claimNext('work_consolidation', 5);
    repo.completeConsolidation('work-c', ['turn-a'], 6);
    expect(repo.listUnintegratedWork(10).map(item => item.turnId)).toEqual(['turn-b']);
  });

  it('启动恢复把 running 重新放回 pending', () => {
    repo.enqueueExtraction('work-a', 'work_extraction', 'turn-a', 1);
    repo.claimNext('work_extraction', 2);
    expect(repo.requeueInterrupted()).toBe(1);
    expect(repo.findById('work-a')).toMatchObject({ status: 'pending', startedAt: null });
  });

  it('忽略保存到 SQL, 不改变失败或错误, 新失败仍提醒', () => {
    repo.enqueueExtraction('failed-a', 'work_extraction', 'turn-a', 1);
    repo.claimNext('work_extraction', 2);
    repo.fail('failed-a', 'upstream error', 3);
    expect(repo.countUnignoredFailures()).toBe(1);
    expect(repo.ignoreFailure('failed-a')).toBe(true);
    expect(repo.ignoreFailure('missing')).toBe(false);

    const reopened = new MemoryRepo(database.db);
    expect(reopened.findDetail('failed-a')).toMatchObject({
      status: 'failed',
      error: 'upstream error',
      reminderIgnored: true,
    });
    expect(database.db.prepare('SELECT reminder_ignored FROM memory_jobs WHERE id = ?')
      .get('failed-a')).toEqual({ reminder_ignored: 1 });
    expect(reopened.countUnignoredFailures()).toBe(0);

    reopened.enqueueExtraction('failed-b', 'work_extraction', 'turn-b', 10);
    reopened.claimNext('work_extraction', 11);
    reopened.fail('failed-b', 'new error', 12);
    const page = reopened.listPage({ startAt: 20, order: 'desc', page: 1 });
    expect(page.items).toEqual([]);
    expect(page.unignoredFailureCount).toBe(1);
    reopened.ignoreAllFailures();
    expect(reopened.countUnignoredFailures()).toBe(0);
    expect(reopened.findDetail('failed-b')?.error).toBe('new error');
  });

  it.each(['asc', 'desc'] as const)('%s 游标和指定页码都按时间与 ID 排序, 返回最多六条', order => {
    const insert = database.db.prepare(`
      INSERT INTO memory_jobs(id, kind, status, created_at)
      VALUES (?, 'work_consolidation', 'completed', ?)
    `);
    for (let index = 0; index < 17; index += 1) {
      insert.run(`job-${String(index).padStart(2, '0')}`, 100 + Math.floor(index / 4));
    }
    const expected = Array.from({ length: 17 }, (_, index) => `job-${String(index).padStart(2, '0')}`);
    if (order === 'desc') expected.reverse();
    const first = repo.listPage({ order, page: 1 });
    expect(first).toMatchObject({ page: 1, pageSize: 6, total: 17, previousCursor: null });
    expect(first.items.map(job => job.id)).toEqual(expected.slice(0, 6));
    const second = repo.listPage({ order, page: 2, cursor: first.nextCursor! });
    expect(second.items.map(job => job.id)).toEqual(expected.slice(6, 12));
    const previous = repo.listPage({ order, page: 1, cursor: second.previousCursor! });
    expect(previous.items).toEqual(first.items);
    const last = repo.listPage({ order, page: 3 });
    expect(last.items.map(job => job.id)).toEqual(expected.slice(12));
    expect(last.nextCursor).toBeNull();
    expect(repo.listPage({ order, page: 100 }).items).toEqual(last.items);
    expect(repo.listPage({ startAt: 101, endAt: 102, order, page: 1 }).items)
      .toHaveLength(4);
    expect(repo.listPage({ startAt: 999, order, page: 1 })).toMatchObject({
      items: [], total: 0, page: 1, previousCursor: null, nextCursor: null,
    });
    expect(first.items[0]).not.toHaveProperty('content');
    expect(first.items[0]).not.toHaveProperty('error');
  });

  it('完成但无内容、等待整理和已经参与整合分别来自真实提取表', () => {
    repo.enqueueExtraction('empty', 'work_extraction', 'turn-a', 10);
    repo.claimNext('work_extraction', 11);
    repo.complete('empty', 12);
    repo.enqueueExtraction('saved', 'relationship_extraction', 'turn-b', 20);
    repo.claimNext('relationship_extraction', 21);
    repo.completeRelationshipExtraction('saved', 'session-a', '其他角色', '稳定偏好', 22);

    expect(repo.findDetail('empty')).toMatchObject({ result: 'no_content', content: null });
    expect(repo.findDetail('saved')).toMatchObject({
      result: 'awaiting_consolidation', content: '稳定偏好', characterName: '其他角色',
    });
    repo.enqueueConsolidationIfAbsent('consolidate', 'relationship_consolidation', 30);
    repo.claimNext('relationship_consolidation', 31);
    repo.completeConsolidation('consolidate', ['turn-b'], 32);
    expect(repo.findDetail('saved')?.result).toBe('consolidated');
    expect(repo.findDetail('consolidate')?.result).toBe('consolidation_completed');
  });
});
