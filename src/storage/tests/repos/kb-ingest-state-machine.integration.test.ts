import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { KbIngestTasksRepo } from '../../repos/kb/kb-ingest-tasks.js';

describe('B-011/B-012 KB 导入任务状态机', () => {
  let database: Database;
  let repo: KbIngestTasksRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'kb' });
    database.migrate();
    repo = new KbIngestTasksRepo(database.sqlite);
  });

  afterEach(() => database.close());

  it('分离 taskId 与 assetId，并用 lease/version CAS 拒绝迟到 Worker', () => {
    const now = Date.now();
    repo.insert({
      id: 'task-1',
      assetId: 'asset-1',
      filePath: 'D:/docs/one.md',
      fileName: 'one.md',
      mimeType: 'text/markdown',
    });

    const first = repo.claimNextPending({
      leaseToken: 'lease-1',
      leaseExpiresAt: now + 60_000,
      now,
    });
    expect(first).toMatchObject({
      id: 'task-1',
      assetId: 'asset-1',
      status: 'running',
      attempt: 1,
      version: 1,
      leaseToken: 'lease-1',
    });
    expect(repo.updateProgress('task-1', 0, 'parse', 0.5)).toBe(false);
    expect(repo.updateProgress('task-1', 1, 'parse', 0.5)).toBe(true);

    const conflicted = repo.partialFail({
      id: 'task-1',
      leaseToken: 'lease-1',
      version: 0,
      stage: 'embed',
      errorCode: 'kb/partial_failed',
      error: '旧 Worker 的迟到结果',
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
      failures: [embeddingFailure('chunk-stale')],
    });
    expect(conflicted).toBeUndefined();
    expect(repo.listFailures('task-1')).toEqual([]);

    const partial = repo.partialFail({
      id: 'task-1',
      leaseToken: 'lease-1',
      version: first!.version,
      stage: 'embed',
      errorCode: 'kb/partial_failed',
      error: '1 个分片失败',
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
      failures: [embeddingFailure('chunk-2')],
    });
    expect(partial).toMatchObject({
      status: 'partial_failed',
      attempt: 1,
      version: 2,
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
    });
    expect(repo.listFailures('task-1')).toMatchObject([
      { taskId: 'task-1', stage: 'embed', itemIds: ['chunk-2'], attempt: 1 },
    ]);

    expect(repo.retry('task-1', 1)).toBeUndefined();
    const pending = repo.retry('task-1', partial!.version);
    expect(pending).toMatchObject({ status: 'pending', attempt: 1, version: 3 });

    const second = repo.claimNextPending({
      leaseToken: 'lease-2',
      leaseExpiresAt: now + 60_000,
      now: now + 3_000,
    });
    expect(second).toMatchObject({ attempt: 2, version: 4, leaseToken: 'lease-2' });

    expect(repo.complete('task-1', 'lease-1', first!.version)).toBe(false);
    expect(repo.complete('task-1', 'lease-2', second!.version)).toBe(true);
    expect(repo.get('task-1')).toBeUndefined();
    expect(repo.listFailures('task-1')).toEqual([]);
  });

  it('应用重启后将幽灵 running 任务安全地重新排队', () => {
    const now = Date.now();
    repo.insert({
      id: 'task-restart',
      assetId: 'asset-restart',
      filePath: 'D:/docs/restart.txt',
      fileName: 'restart.txt',
    });
    repo.claimNextPending({
      leaseToken: 'dead-worker',
      leaseExpiresAt: now + 2_000,
      now,
    });

    expect(repo.recoverInterrupted(now + 3_000)).toBe(1);
    expect(repo.get('task-restart')).toMatchObject({
      status: 'pending',
      errorCode: 'kb/process_interrupted',
      version: 2,
    });
  });

  it('下一个 claim 会回收已过期租约，并使旧版本失效', () => {
    const now = Date.now();
    repo.insert({
      id: 'task-expired',
      assetId: 'asset-expired',
      filePath: 'D:/docs/expired.txt',
      fileName: 'expired.txt',
    });
    const expired = repo.claimNextPending({
      leaseToken: 'lease-expired',
      leaseExpiresAt: now + 10,
      now,
    });

    const reclaimed = repo.claimNextPending({
      leaseToken: 'lease-current',
      leaseExpiresAt: now + 60_000,
      now: now + 11,
    });
    expect(reclaimed).toMatchObject({
      id: 'task-expired',
      attempt: 2,
      version: 3,
      leaseToken: 'lease-current',
    });
    expect(repo.complete('task-expired', 'lease-expired', expired!.version)).toBe(false);
  });
});

function embeddingFailure(chunkId: string) {
  return {
    stage: 'embed' as const,
    shardKey: 'embed:0',
    itemIds: [chunkId],
    retryable: true,
    errorCode: 'kb/embed-batch-failed',
    error: 'provider unavailable',
  };
}
