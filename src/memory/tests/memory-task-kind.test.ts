// 测试未实现的 Memory 任务无法入队，历史遗留任务也不会被谎报为完成。
import { describe, expect, it, vi } from 'vitest';
import { asSessionId } from '@ema-agent/contracts';
import type { MemoryTaskRow } from '@ema-agent/storage';
import {
  MemoryTaskRunner,
  UnsupportedMemoryTaskKindError,
  type MemoryTaskRunnerDeps,
} from '../tasks/extraction-runner.js';
import { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';
import { SessionTaskQueue } from '../tasks/session-queue.js';

function baseDeps(memoryTasks: Record<string, unknown>): MemoryTaskRunnerDeps {
  return {
    memory: { memoryTasks } as unknown as MemoryTaskRunnerDeps['memory'],
    embed: {} as MemoryTaskRunnerDeps['embed'],
    settings: {} as MemoryTaskRunnerDeps['settings'],
    queue: new SessionTaskQueue(),
    commitCoordinator: new MemoryCommitCoordinator(),
    getNodesIndex: () => null,
    getItemsIndex: () => null,
    getIndexSpaceId: () => null,
    getSessionOverrides: () => ({
      layer0: true, layer1: true, layer2: true,
      extraction: true, consolidation: true,
    }),
  };
}

describe('MemoryTaskRunner supported kinds', () => {
  it('运行时拒绝绕过 TypeScript 传入的未实现任务', () => {
    const enqueue = vi.fn();
    const runner = new MemoryTaskRunner(baseDeps({ enqueue }));

    expect(() => runner.enqueue(
      'maintenance' as never,
      asSessionId('session-1'),
      {},
    )).toThrow(UnsupportedMemoryTaskKindError);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('历史遗留任务直接失败一次，不进入 completed 或重试', async () => {
    const row: MemoryTaskRow = {
      id: 'legacy-task',
      kind: 'embedding_refresh',
      status: 'running',
      session_id: 'session-1',
      payload_json: JSON.stringify({ sessionId: 'session-1' }),
      attempts: 1,
      last_error: null,
      created_at: 1,
      updated_at: 1,
    };
    let claimed = false;
    const markCompleted = vi.fn();
    const markFailed = vi.fn((_id, _attempt, error: string, _at, maxAttempts: number) => ({
      ...row,
      status: 'failed',
      last_error: error,
      maxAttempts,
    }));
    const runner = new MemoryTaskRunner(baseDeps({
      requeueExpiredRunning: vi.fn(),
      deleteTerminal: vi.fn(),
      claimNext: vi.fn(() => {
        if (claimed) return undefined;
        claimed = true;
        return row;
      }),
      heartbeat: vi.fn(() => true),
      markCompleted,
      markFailed,
    }));

    await runner.tick();

    expect(markCompleted).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      'legacy-task', 1, expect.stringContaining('not implemented'), expect.any(Number), 1,
    );
  });
});
