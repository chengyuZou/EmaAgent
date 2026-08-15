// 测试 Memory worker 只并发不同 Session、同 Session 保序，并在关机后停止认领新任务。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database, MemoryTasksRepo } from '@ema-agent/storage';
import { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';
import {
  MemoryTaskRunner,
  type MemoryTaskRunnerDeps,
} from '../tasks/extraction-runner.js';
import { SessionTaskQueue } from '../tasks/session-queue.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const opened: Database[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness(taskIds: Array<{ id: string; sessionId: string }>) {
  const database = new Database({ memory: true, kind: 'data' });
  opened.push(database);
  database.migrate();
  const tasks = new MemoryTasksRepo(database.sqlite);
  const now = Date.now();

  for (const sessionId of new Set(taskIds.map(task => task.sessionId))) {
    database.sqlite.prepare(
      `INSERT INTO sessions (id, title, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, sessionId, now, now, now);
  }
  taskIds.forEach((task, index) => tasks.enqueue({
    id: task.id,
    kind: 'extraction',
    sessionId: task.sessionId,
    payload: { sessionId: task.sessionId, executionProfile: 'chat' },
    createdAt: now + index,
  }));

  const gates = new Map(taskIds.map(task => [task.id, deferred()]));
  const signals = new Map<string, AbortSignal>();
  const started: string[] = [];
  let active = 0;
  let peakActive = 0;
  const runPipeline: NonNullable<MemoryTaskRunnerDeps['runPipeline']> = async (_deps, args) => {
    started.push(args.runId);
    if (args.signal) signals.set(args.runId, args.signal);
    active++;
    peakActive = Math.max(peakActive, active);
    await gates.get(args.runId)!.promise;
    active--;
    return {
      extractedNodes: 0,
      extractedEdges: 0,
      extractedItems: 0,
      lazyUpdatesQueued: 0,
      consolidatedNodes: 0,
      droppedEdges: 0,
    };
  };
  const runner = new MemoryTaskRunner({
    memory: { memoryTasks: tasks } as unknown as MemoryTaskRunnerDeps['memory'],
    embed: {} as MemoryTaskRunnerDeps['embed'],
    settings: {} as MemoryTaskRunnerDeps['settings'],
    queue: new SessionTaskQueue(),
    commitCoordinator: new MemoryCommitCoordinator(),
    getNodesIndex: () => null,
    getItemsIndex: () => null,
    getIndexSpaceId: () => null,
    getSessionOverrides: () => ({
      layer0: true,
      layer1: true,
      layer2: true,
      extraction: true,
      consolidation: true,
    }),
    refreshIndexes: async () => undefined,
    runPipeline,
  });

  return {
    runner,
    tasks,
    gates,
    signals,
    started,
    peakActive: () => peakActive,
  };
}

describe('B-051 MemoryTaskRunner 跨 Session 有界并发', () => {
  it('两个 worker 并发不同 Session，同 Session 的下一项等待前项完成', async () => {
    const h = createHarness([
      { id: 'a-1', sessionId: 'session-a' },
      { id: 'a-2', sessionId: 'session-a' },
      { id: 'b-1', sessionId: 'session-b' },
    ]);

    const tick = h.runner.tick();
    await vi.waitFor(() => expect(h.started).toEqual(['a-1', 'b-1']));
    expect(h.peakActive()).toBe(2);

    h.gates.get('b-1')!.resolve();
    await vi.waitFor(() => expect(h.tasks.findById('b-1')?.status).toBe('completed'));
    expect(h.started).not.toContain('a-2');

    h.gates.get('a-1')!.resolve();
    await vi.waitFor(() => expect(h.started).toContain('a-2'));
    h.gates.get('a-2')!.resolve();
    await tick;

    expect(h.tasks.findById('a-1')?.status).toBe('completed');
    expect(h.tasks.findById('a-2')?.status).toBe('completed');
  });

  it('shutdown 等待在途任务，但不再认领尚未开始的任务', async () => {
    const h = createHarness([
      { id: 'a-1', sessionId: 'session-a' },
      { id: 'a-2', sessionId: 'session-a' },
    ]);

    void h.runner.tick();
    await vi.waitFor(() => expect(h.started).toEqual(['a-1']));
    const shutdown = h.runner.shutdown();
    h.gates.get('a-1')!.resolve();
    await shutdown;

    expect(h.tasks.findById('a-1')?.status).toBe('completed');
    expect(h.tasks.findById('a-2')?.status).toBe('pending');
    expect(h.started).toEqual(['a-1']);
  });

  it('Session 删除会撤销任务租约、取消模型调用并丢弃迟到结果', async () => {
    const h = createHarness([
      { id: 'a-1', sessionId: 'session-a' },
      { id: 'a-2', sessionId: 'session-a' },
      { id: 'b-1', sessionId: 'session-b' },
    ]);

    const tick = h.runner.tick();
    await vi.waitFor(() => expect(h.started).toEqual(['a-1', 'b-1']));

    const cancellation = h.runner.cancelSession(asSessionId('session-a'));
    expect(h.tasks.findById('a-1')).toBeUndefined();
    expect(h.tasks.findById('a-2')).toBeUndefined();
    expect(h.signals.get('a-1')?.aborted).toBe(true);
    await expect(cancellation).resolves.toBeUndefined();

    // 删除协调不能等待 Provider；即便 Provider 迟到返回，Runner 仍须再次验租约。
    h.gates.get('a-1')!.resolve();
    h.gates.get('b-1')!.resolve();
    await tick;

    expect(h.tasks.findById('b-1')?.status).toBe('completed');
    expect(h.started).not.toContain('a-2');
  });

  it('不同 Session 可以并行计算，但全局 Memory 提交始终串行', async () => {
    const coordinator = new MemoryCommitCoordinator();
    const releaseCompute = deferred();
    const releaseFirstCommit = deferred();
    let activeCompute = 0;
    let peakCompute = 0;
    let activeCommit = 0;
    let peakCommit = 0;
    const commitOrder: string[] = [];

    const runSession = async (sessionId: string): Promise<void> => {
      activeCompute++;
      peakCompute = Math.max(peakCompute, activeCompute);
      await releaseCompute.promise;
      activeCompute--;

      await coordinator.runExclusive(async () => {
        activeCommit++;
        peakCommit = Math.max(peakCommit, activeCommit);
        commitOrder.push(sessionId);
        if (commitOrder.length === 1) await releaseFirstCommit.promise;
        activeCommit--;
      });
    };

    const first = runSession('session-a');
    const second = runSession('session-b');
    expect(peakCompute).toBe(2);

    releaseCompute.resolve();
    await vi.waitFor(() => expect(commitOrder).toHaveLength(1));
    expect(activeCommit).toBe(1);
    expect(peakCommit).toBe(1);

    releaseFirstCommit.resolve();
    await Promise.all([first, second]);

    expect(commitOrder).toEqual(['session-a', 'session-b']);
    expect(peakCommit).toBe(1);
  });
});
