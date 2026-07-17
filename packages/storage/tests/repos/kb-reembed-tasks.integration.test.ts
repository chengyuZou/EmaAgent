// 测试 B-075 重建任务持久队列: 租约领取/心跳/终态 CAS/取消/重试/崩溃恢复的语义
// 与 KbIngestTasksRepo 同型, 防"审批旧状态、覆盖新状态"。

import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/database.js';
import { KbReembedTasksRepo } from '../../src/repos/kb-reembed-tasks.js';

describe('KbReembedTasksRepo', () => {
  const databases: Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function setup(): KbReembedTasksRepo {
    const database = new Database({ memory: true, kind: 'kb' });
    databases.push(database);
    database.migrate();
    return new KbReembedTasksRepo(database.sqlite);
  }

  it('insert/get/findActive: pending 与 running 都算活跃任务', () => {
    const repo = setup();
    repo.insert({ id: 't1', ebdProviderId: 'p1', ebdModel: 'm1' });
    expect(repo.get('t1')).toMatchObject({ status: 'pending', ebdProviderId: 'p1', ebdModel: 'm1' });
    expect(repo.findActive()?.id).toBe('t1');
  });

  it('claimNextPending 原子领取: 累加 attempt/version 并写租约, 无可领时返回 undefined', () => {
    const repo = setup();
    repo.insert({ id: 't1', ebdProviderId: 'p1', ebdModel: 'm1' });

    const now = Date.now();
    const claimed = repo.claimNextPending({ leaseToken: 'lease-a', leaseExpiresAt: now + 60_000, now });
    expect(claimed).toMatchObject({ status: 'running', attempt: 1, version: 1, leaseToken: 'lease-a' });
    expect(repo.claimNextPending({ leaseToken: 'lease-b', leaseExpiresAt: now + 60_000, now })).toBeUndefined();
  });

  it('租约过期的 running 任务先被回收再重新排队, version 递增使迟到 CAS 失效', () => {
    const repo = setup();
    repo.insert({ id: 't1', ebdProviderId: 'p1', ebdModel: 'm1' });
    const now = Date.now();
    const first = repo.claimNextPending({ leaseToken: 'lease-a', leaseExpiresAt: now + 1_000, now })!;

    // 旧 Worker 心跳已断: 租约过期后应被回收并重新排队领取。
    const second = repo.claimNextPending({ leaseToken: 'lease-b', leaseExpiresAt: now + 60_000, now: now + 2_000 });
    expect(second).toMatchObject({ status: 'running', attempt: 2, version: first.version + 2, leaseToken: 'lease-b' });

    // 旧 Worker 的迟到终态 CAS 必须失败(token 与 version 都已失效)。
    expect(repo.complete('t1', 'lease-a', first.version)).toBe(false);
  });

  it('extendLease 只在 token/attempt/租约窗口全对时续租', () => {
    const repo = setup();
    repo.insert({ id: 't1', ebdProviderId: 'p1', ebdModel: 'm1' });
    const now = Date.now();
    repo.claimNextPending({ leaseToken: 'lease-a', leaseExpiresAt: now + 60_000, now });

    expect(repo.extendLease('t1', 'lease-a', 1, now + 120_000, now)).toBe(true);
    expect(repo.extendLease('t1', 'wrong-token', 1, now + 120_000, now)).toBe(false);
    expect(repo.extendLease('t1', 'lease-a', 99, now + 120_000, now)).toBe(false);
  });

  it('complete 删除任务行; fail 记 failed 且 retry 重新排队', () => {
    const repo = setup();
    repo.insert({ id: 't1', ebdProviderId: 'p1', ebdModel: 'm1' });
    repo.insert({ id: 't2', ebdProviderId: 'p1', ebdModel: 'm1' });

    const now = Date.now();
    const t1 = repo.claimNextPending({ leaseToken: 'l1', leaseExpiresAt: now + 60_000, now })!;
    expect(repo.complete('t1', 'l1', t1.version)).toBe(true);
    expect(repo.get('t1')).toBeUndefined();

    const t2 = repo.claimNextPending({ leaseToken: 'l2', leaseExpiresAt: now + 60_000, now })!;
    const failed = repo.fail({ id: 't2', leaseToken: 'l2', version: t2.version, errorCode: 'kb/reembed_failed', error: 'boom' });
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'kb/reembed_failed' });
    expect(repo.retry('t2', failed!.version)).toMatchObject({ status: 'pending' });
  });

  it('partialFail 在同一事务内写失败分片', () => {
    const repo = setup();
    repo.insert({ id: 't1', ebdProviderId: 'p1', ebdModel: 'm1' });
    const now = Date.now();
    const claimed = repo.claimNextPending({ leaseToken: 'l1', leaseExpiresAt: now + 60_000, now })!;

    const partial = repo.partialFail({
      id: 't1',
      leaseToken: 'l1',
      version: claimed.version,
      stage: 'embed',
      errorCode: 'kb/partial_failed',
      error: '1/3 个文档重建失败',
      totalItems: 3,
      completedItems: 2,
      failedItems: 1,
      failures: [{
        stage: 'embed',
        shardKey: 'reembed:asset:asset-x',
        itemIds: ['asset-x'],
        retryable: true,
        error: 'provider unavailable',
      }],
    });

    expect(partial).toMatchObject({ status: 'partial_failed', totalItems: 3, completedItems: 2, failedItems: 1 });
    expect(repo.listFailures('t1')).toHaveLength(1);
    expect(repo.listFailures('t1')[0]).toMatchObject({ shardKey: 'reembed:asset:asset-x', retryable: true });
  });

  it('cancel 把 pending/running 置为 cancelled 且 version 递增, 迟到 complete CAS 失败', () => {
    const repo = setup();
    repo.insert({ id: 't1', ebdProviderId: 'p1', ebdModel: 'm1' });
    const now = Date.now();
    const claimed = repo.claimNextPending({ leaseToken: 'l1', leaseExpiresAt: now + 60_000, now })!;

    expect(repo.cancel('t1')).toBe(true);
    expect(repo.get('t1')).toMatchObject({ status: 'cancelled', version: claimed.version + 1 });
    expect(repo.complete('t1', 'l1', claimed.version)).toBe(false);
    // 已取消的任务可以重新排队。
    expect(repo.retry('t1', claimed.version + 1)).toMatchObject({ status: 'pending' });
  });

  it('recoverInterrupted 把幽灵 running 安全重新排队', () => {
    const repo = setup();
    repo.insert({ id: 't1', ebdProviderId: 'p1', ebdModel: 'm1' });
    const now = Date.now();
    repo.claimNextPending({ leaseToken: 'l1', leaseExpiresAt: now + 60_000, now });

    expect(repo.recoverInterrupted(now)).toBe(1);
    expect(repo.get('t1')).toMatchObject({ status: 'pending', errorCode: 'kb/process_interrupted' });
  });
});
