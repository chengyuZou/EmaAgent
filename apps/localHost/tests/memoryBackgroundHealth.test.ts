// 验证 Memory 后台健康投影按维护动作累计失败、识别存储压力并忽略预期取消。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackgroundHealthTracker } from '../src/background/memoryBackgroundHealth.js';

describe('MemoryBackgroundHealthTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一维护动作连续失败三次才进入退化', () => {
    const emit = vi.fn();
    const health = new MemoryBackgroundHealthTracker(emit);

    health.fail('embeddingRepair');
    health.fail('embeddingRepair');

    expect(health.snapshot()).toEqual(
      expect.objectContaining({
        state: 'idle',
        consecutiveFailures: 2,
      }),
    );
    expect(emit).not.toHaveBeenCalled();

    health.fail('embeddingRepair');

    expect(health.snapshot()).toEqual({
      state: 'degraded',
      lastFailure: {
        operation: 'embeddingRepair',
        occurredAt: 1_000,
        message: 'Memory 向量修复连续失败',
      },
      consecutiveFailures: 3,
    });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('其他动作成功不会掩盖仍在连续失败的维护动作', () => {
    const emit = vi.fn();
    const health = new MemoryBackgroundHealthTracker(emit);
    health.fail('embeddingRepair');
    health.fail('embeddingRepair');
    health.fail('embeddingRepair');

    health.begin('decay');
    health.complete('decay');

    expect(health.snapshot()).toEqual(
      expect.objectContaining({
        state: 'degraded',
        consecutiveFailures: 3,
      }),
    );
    expect(emit).toHaveBeenCalledTimes(1);

    health.begin('embeddingRepair');
    health.complete('embeddingRepair');

    expect(health.snapshot()).toEqual({
      state: 'idle',
      lastCompletedAt: 1_000,
      consecutiveFailures: 0,
    });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({
      type: 'memory_background_health_changed',
      health: {
        state: 'idle',
        lastCompletedAt: 1_000,
        consecutiveFailures: 0,
      },
    });
  });

  it('预算执行后仍超限会立即退化，下一次解除压力后恢复', () => {
    const emit = vi.fn();
    const health = new MemoryBackgroundHealthTracker(emit);

    health.begin('storageBudget');
    health.complete('storageBudget', {
      usedBytes: 600,
      maxBytes: 500,
      remainsOverLimit: true,
    });

    expect(health.snapshot()).toEqual({
      state: 'degraded',
      lastCompletedAt: 1_000,
      consecutiveFailures: 0,
      storagePressure: {
        usedBytes: 600,
        maxBytes: 500,
        remainsOverLimit: true,
      },
    });

    vi.setSystemTime(2_000);
    health.begin('storageBudget');
    health.complete('storageBudget', {
      usedBytes: 400,
      maxBytes: 500,
      remainsOverLimit: false,
    });

    expect(health.snapshot()).toEqual({
      state: 'idle',
      lastCompletedAt: 2_000,
      consecutiveFailures: 0,
      storagePressure: {
        usedBytes: 400,
        maxBytes: 500,
        remainsOverLimit: false,
      },
    });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('预期取消只清除运行态，不累计失败或发布警告', () => {
    const emit = vi.fn();
    const health = new MemoryBackgroundHealthTracker(emit);

    health.begin('consolidation');
    expect(health.snapshot()).toEqual({
      state: 'running',
      activeOperation: 'consolidation',
      consecutiveFailures: 0,
    });

    health.cancel('consolidation');

    expect(health.snapshot()).toEqual({
      state: 'idle',
      consecutiveFailures: 0,
    });
    expect(emit).not.toHaveBeenCalled();
  });
});
