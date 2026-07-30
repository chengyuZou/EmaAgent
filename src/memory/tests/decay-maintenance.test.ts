// 测试 Memory 衰减分批提交、前台取消与完成事件边界。

import { describe, expect, it, vi } from 'vitest';
import type { MemoryDeps } from '../deps.js';
import { runMaintenance } from '../maintenance/decay.js';
import { MemoryCommitCoordinator } from '../tasks/commit-coordinator.js';

describe('Memory 衰减维护', () => {
  it('前台取消发生在批次之间时保留已提交批次，但不发布完成事件', async () => {
    const controller = new AbortController();
    const rows = Array.from({ length: 250 }, (_, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
      node_type: 'entity' as const,
      importance: 50,
      last_referenced_at: 1,
      last_decayed_at: null,
    }));
    const pending = new Map(rows.map(row => [row.id, row]));
    const emit = vi.fn();
    let applyCount = 0;
    const deps = {
      nodes: {
        listDecayCandidates: (
          _cutoff: number,
          _cycleCutoff: number,
          _protected: readonly string[],
          limit: number,
        ) => [...pending.values()].slice(0, limit),
        applyDecayUpdates: (updates: Array<{ id: string }>) => {
          applyCount++;
          for (const update of updates) pending.delete(update.id);
          if (applyCount === 1) {
            controller.abort(new DOMException('前台 Turn 已开始', 'AbortError'));
          }
          return updates.map(update => update.id);
        },
      },
      items: {
        listDecayCandidates: () => [],
        applyDecayUpdates: () => [],
      },
      runProfileTransaction: <T>(work: () => T) => work(),
      emit,
    } as unknown as MemoryDeps;

    await expect(runMaintenance(
      deps,
      {
        decayAfterDays: 30,
        decayAmount: 10,
        decayItems: true,
        dryRun: false,
        nowMs: 40 * 86_400_000,
      },
      new MemoryCommitCoordinator(),
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(pending.size).toBe(50);
    expect(applyCount).toBe(1);
    expect(emit).not.toHaveBeenCalled();
  });
});
