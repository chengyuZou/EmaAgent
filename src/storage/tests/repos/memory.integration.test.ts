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
      INSERT INTO sessions(id, title, created_at, updated_at)
      VALUES ('session-a', 'Session A', 1, 1)
    `).run();
    for (const [id, at] of [['turn-a', 1], ['turn-b', 2]] as const) {
      database.db.prepare(`
        INSERT INTO turns(
          id, session_id, trigger_type, execution_profile,
          narrative_policy, status, created_at
        ) VALUES (?, 'session-a', 'userMessage', 'chat', 'off', 'completed', ?)
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
});
