// 测试 B-075 重建任务队列: 幂等入队、失败分片、取消、重试、崩溃恢复,
// 语义与 IngestQueue 对齐(迟到 Promise 不得覆盖取消/重试后的新状态)。

import { afterEach, describe, expect, it } from 'vitest';
import { Database, KbReembedTasksRepo } from '@ema-agent/storage';
import { DocumentEventEmitter } from '../events/emitter.js';
import { ReembedQueue, type ReembedSweepInput, type ReembedSweepOutcome } from '../reembed/queue.js';

describe('B-075 ReembedQueue', () => {
  const databases: Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function setup(sweep: (input: ReembedSweepInput) => Promise<ReembedSweepOutcome>) {
    const database = new Database({ memory: true, kind: 'kb' });
    databases.push(database);
    database.migrate();
    const tasks = new KbReembedTasksRepo(database.sqlite);
    const events = new DocumentEventEmitter();
    const queue = new ReembedQueue({ tasks, sweep, events });
    return { tasks, events, queue };
  }

  it('入队后跑完即删除任务行; 重复入队幂等复用同一任务', async () => {
    const { tasks, queue, events } = setup(async () => ({ total: 2, done: 2, failed: [] }));
    const terminalStates: Array<string | undefined> = [];
    events.on((event) => {
      if (event.operation === 'reembed' && event.kind === 'complete' && event.taskId) {
        terminalStates.push(tasks.get(event.taskId)?.status);
      }
    });

    const first = queue.enqueue({ ebdProviderId: 'p1', ebdModel: 'm1' });
    const second = queue.enqueue({ ebdProviderId: 'p1', ebdModel: 'm1' });
    expect(second.id).toBe(first.id);

    await waitUntil(() => tasks.get(first.id) === undefined);
    expect(terminalStates).toEqual([undefined]);
  });

  it('单资产失败记 partial_failed + 失败分片, 重试沿用同一任务身份', async () => {
    let calls = 0;
    const { tasks, queue, events } = setup(async () => {
      calls++;
      return calls === 1
        ? { total: 3, done: 2, failed: [{ assetId: 'asset-x', error: 'provider unavailable' }] }
        : { total: 1, done: 1, failed: [] };
    });
    const terminalStates: Array<string | undefined> = [];
    events.on((event) => {
      if (event.operation === 'reembed' && event.kind === 'partial_failed' && event.taskId) {
        terminalStates.push(tasks.get(event.taskId)?.status);
      }
    });

    const task = queue.enqueue({ ebdProviderId: 'p1', ebdModel: 'm1' });
    await waitUntil(() => tasks.get(task.id)?.status === 'partial_failed');

    expect(tasks.listFailures(task.id)).toHaveLength(1);
    expect(tasks.listFailures(task.id)[0]).toMatchObject({
      shardKey: 'reembed:asset:asset-x',
      retryable: true,
    });
    expect(terminalStates).toEqual(['partial_failed']);

    expect(queue.retry(task.id)).toBe(true);
    await waitUntil(() => tasks.get(task.id) === undefined);
    expect(calls).toBe(2);
  });

  it('用户取消: 持久态为 cancelled 且不被 Worker 迟到终态覆盖', async () => {
    const { tasks, queue, events } = setup((input) =>
      new Promise<ReembedSweepOutcome>((resolve) => {
        input.signal.addEventListener('abort', () => resolve({ total: 3, done: 1, failed: [] }));
      }),
    );
    const cancelNotices: string[] = [];
    events.on((e) => {
      if (e.operation === 'reembed' && e.kind === 'cancelled') cancelNotices.push(e.taskId ?? '');
    });

    const task = queue.enqueue({ ebdProviderId: 'p1', ebdModel: 'm1' });
    await waitUntil(() => tasks.get(task.id)?.status === 'running');
    expect(queue.cancel(task.id)).toBe(true);

    await waitUntil(() => tasks.get(task.id)?.status === 'cancelled');
    // 给 Worker 一个兑现迟到终态的机会; cancelled 必须保持不变。
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(tasks.get(task.id)?.status).toBe('cancelled');
    expect(cancelNotices).toEqual([task.id]);
  });

  it('扫描器抛错时先持久化 failed，再发布一次失败终态', async () => {
    const { tasks, queue, events } = setup(async () => {
      throw new Error('provider unavailable');
    });
    const terminalStates: Array<{ status: string | undefined; error: string | undefined }> = [];
    events.on((event) => {
      if (event.operation === 'reembed' && event.kind === 'error' && event.taskId) {
        terminalStates.push({
          status: tasks.get(event.taskId)?.status,
          error: event.error,
        });
      }
    });

    const task = queue.enqueue({ ebdProviderId: 'p1', ebdModel: 'm1' });
    await waitUntil(() => tasks.get(task.id)?.status === 'failed');

    expect(terminalStates).toEqual([{
      status: 'failed',
      error: 'provider unavailable',
    }]);
  });

  it('resume 把幽灵 running 重新排队并跑完', async () => {
    const database = new Database({ memory: true, kind: 'kb' });
    databases.push(database);
    database.migrate();
    const tasks = new KbReembedTasksRepo(database.sqlite);
    tasks.insert({ id: 'ghost', ebdProviderId: 'p1', ebdModel: 'm1' });
    tasks.claimNextPending({ leaseToken: 'old', leaseExpiresAt: Date.now() + 60_000, now: Date.now() });
    expect(tasks.get('ghost')?.status).toBe('running');

    const queue = new ReembedQueue({
      tasks,
      sweep: async () => ({ total: 0, done: 0, failed: [] }),
      events: new DocumentEventEmitter(),
    });
    queue.resume();
    await waitUntil(() => tasks.get('ghost') === undefined);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待异步队列状态超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
