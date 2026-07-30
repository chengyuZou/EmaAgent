// 测试 LocalHost 后台生命周期只启动一次、按周期探测 Bridge，并有序排空资源。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundWork } from '../src/background/backgroundWork.js';
import { MemoryBackgroundHealthTracker } from '../src/background/memoryBackgroundHealth.js';

function createHarness() {
  let activeTurnCount = 0;
  const activeTurnListeners = new Set<(activeCount: number) => void>();
  const startupRecovery = {
    runRequired: vi.fn(),
    runMaintenance: vi.fn(() => ({ memoryReady: true })),
  };
  const foregroundActivity = {
    hasActiveTurns: vi.fn(() => activeTurnCount > 0),
    subscribeActiveTurns: vi.fn((listener: (activeCount: number) => void) => {
      activeTurnListeners.add(listener);
      listener(activeTurnCount);
      return () => activeTurnListeners.delete(listener);
    }),
  };
  const memory = {
    initialize: vi.fn(async () => ({ nodes: 0, items: 0, backend: null })),
    tick: vi.fn(async () => undefined),
    drain: vi.fn(async () => undefined),
    runMaintenance: vi.fn(async () => ({
      dryRun: false,
      decayedNodes: 0,
      decayedItems: 0,
      preview: { nodes: [], items: [], decayedAt: 0 },
    })),
    consolidatePendingNodes: vi.fn(async () => ({
      pendingNodes: 0,
      consolidated: 0,
      conflicts: 0,
      orphanUpdatesDeleted: 0,
    })),
    repairStaleEmbeddings: vi.fn(async () => ({
      ran: true,
      nodesRepaired: 0,
      itemsRepaired: 0,
      failed: 0,
      remaining: 0,
    })),
    enforceStorageBudget: vi.fn(async () => ({
      ran: false,
      beforeBytes: 0,
      afterBytes: 0,
      maxBytes: 0,
      targetBytes: 0,
      expiredItemsDeleted: 0,
      coldNodesDeleted: 0,
      coldItemsDeleted: 0,
      nodeEmbeddingsEvicted: 0,
      itemEmbeddingsEvicted: 0,
      pressureRemaining: false,
    })),
  };
  const mcp = {
    primeFromCache: vi.fn(() => 0),
    discoverUncached: vi.fn(async () => 0),
    disconnectAll: vi.fn(async () => undefined),
  };
  const toolResults = {
    sweep: vi.fn(() => ({ deleted: 0, freedBytes: 0 })),
  };
  const attachmentCache = {
    sweepIfIdle: vi.fn(async () => ({
      ran: false,
      deletedDerivations: 0,
      deletedImages: 0,
      freedBytes: 0,
    })),
  };
  const narrative = {
    isReady: vi.fn(async () => true),
  };
  const providerRuntime = {
    syncBridge: vi.fn(async () => undefined),
  };
  const systemEvents = {
    emit: vi.fn(),
  };
  const memoryHealth = new MemoryBackgroundHealthTracker(systemEvents.emit);

  const work = new BackgroundWork(
    startupRecovery,
    foregroundActivity,
    memory,
    mcp,
    toolResults,
    attachmentCache,
    narrative,
    providerRuntime,
    systemEvents,
    memoryHealth,
  );

  return {
    work,
    foregroundActivity,
    setActiveTurnCount(activeCount: number) {
      activeTurnCount = activeCount;
      for (const listener of activeTurnListeners) listener(activeCount);
    },
    startupRecovery,
    memory,
    mcp,
    toolResults,
    attachmentCache,
    narrative,
    providerRuntime,
    systemEvents,
    memoryHealth,
  };
}

describe('BackgroundWork', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('重复 start 不会创建第二套恢复和常驻任务', async () => {
    const harness = createHarness();

    harness.work.start();
    harness.work.start();
    await vi.waitFor(() => {
      expect(harness.memory.initialize).toHaveBeenCalledTimes(1);
    });

    expect(harness.startupRecovery.runRequired).toHaveBeenCalledTimes(1);
    expect(harness.startupRecovery.runMaintenance).toHaveBeenCalledTimes(1);
    expect(harness.mcp.primeFromCache).toHaveBeenCalledTimes(1);
    expect(harness.mcp.discoverUncached).toHaveBeenCalledTimes(1);

    await harness.work.shutdown();
    await harness.work.shutdown();

    expect(harness.memory.drain).toHaveBeenCalledTimes(1);
    expect(harness.mcp.disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('必需恢复失败会阻止后台 Worker 和 MCP 启动', () => {
    const harness = createHarness();
    harness.startupRecovery.runRequired.mockImplementation(() => {
      throw new Error('turn recovery failed');
    });

    expect(() => harness.work.start()).toThrow('turn recovery failed');
    expect(harness.memory.initialize).not.toHaveBeenCalled();
    expect(harness.mcp.primeFromCache).not.toHaveBeenCalled();
    expect(harness.mcp.discoverUncached).not.toHaveBeenCalled();
  });

  it('Memory 恢复失败时只禁用 Memory Worker，其余后台维护继续运行', async () => {
    const harness = createHarness();
    harness.startupRecovery.runMaintenance.mockReturnValue({
      memoryReady: false,
    });

    harness.work.start();
    await vi.waitFor(() => {
      expect(harness.startupRecovery.runMaintenance).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.memory.initialize).not.toHaveBeenCalled();
    expect(harness.memory.tick).not.toHaveBeenCalled();
    expect(harness.mcp.discoverUncached).toHaveBeenCalledTimes(1);
    expect(harness.memoryHealth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'degraded',
        consecutiveFailures: 3,
      }),
    );

    await harness.work.shutdown();
    expect(harness.memory.drain).not.toHaveBeenCalled();
    expect(harness.mcp.disconnectAll).toHaveBeenCalledTimes(1);
  });

  it('Bridge 首次不可达会告警，后续恢复会发布恢复事件', async () => {
    const harness = createHarness();
    harness.narrative.isReady
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    harness.work.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.providerRuntime.syncBridge).toHaveBeenCalledTimes(1);
    expect(harness.systemEvents.emit).toHaveBeenNthCalledWith(1, {
      type: 'system_warning',
      level: 'warn',
      message: 'Narrative bridge 不可达 — narrative 模式暂时降级',
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.providerRuntime.syncBridge).toHaveBeenCalledTimes(2);
    expect(harness.systemEvents.emit).toHaveBeenNthCalledWith(2, {
      type: 'system_warning',
      level: 'info',
      message: 'Narrative bridge 已恢复',
    });

    await harness.work.shutdown();
  });

  it('有活动 Turn 时跳过重维护，Turn 结束后重新等待空闲窗口', async () => {
    const harness = createHarness();
    harness.work.start();
    await vi.waitFor(() => {
      expect(harness.memory.initialize).toHaveBeenCalledTimes(1);
    });

    harness.setActiveTurnCount(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(harness.memory.enforceStorageBudget).not.toHaveBeenCalled();
    expect(harness.memory.repairStaleEmbeddings).not.toHaveBeenCalled();

    harness.setActiveTurnCount(0);
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 5_000);
    expect(harness.memory.enforceStorageBudget).toHaveBeenCalledTimes(1);
    expect(harness.memory.repairStaleEmbeddings).toHaveBeenCalledTimes(1);

    await harness.work.shutdown();
  });

  it('空闲一分钟后按顺序执行衰减与少量残留归并', async () => {
    const harness = createHarness();
    harness.work.start();
    await vi.waitFor(() => {
      expect(harness.memory.initialize).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.memory.runMaintenance).toHaveBeenCalledTimes(1);
    expect(harness.memory.consolidatePendingNodes).toHaveBeenCalledWith(
      10,
      expect.any(AbortSignal),
    );
    expect(
      harness.memory.runMaintenance.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.memory.consolidatePendingNodes.mock.invocationCallOrder[0]!,
    );

    await harness.work.shutdown();
  });

  it('空闲一分钟后运行轻量衰减，新 Turn 出现时取消当前批次', async () => {
    const harness = createHarness();
    harness.memory.runMaintenance.mockImplementation(async (_opts, signal?: AbortSignal) => {
      harness.setActiveTurnCount(1);
      expect(signal?.aborted).toBe(true);
      signal?.throwIfAborted();
      throw new Error('unreachable');
    });

    harness.work.start();
    await vi.waitFor(() => {
      expect(harness.memory.initialize).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.memory.runMaintenance).toHaveBeenCalledWith(
      { dryRun: false },
      expect.any(AbortSignal),
    );
    expect(harness.memory.enforceStorageBudget).not.toHaveBeenCalled();
    expect(harness.memoryHealth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'idle',
        consecutiveFailures: 0,
      }),
    );

    await harness.work.shutdown();
  });

  it('后台重维护运行时出现新 Turn 会取消当前批次且不继续修复向量', async () => {
    const harness = createHarness();
    harness.memory.enforceStorageBudget.mockImplementation(async (signal?: AbortSignal) => {
      harness.setActiveTurnCount(1);
      expect(signal?.aborted).toBe(true);
      signal?.throwIfAborted();
      throw new Error('unreachable');
    });

    harness.work.start();
    await vi.waitFor(() => {
      expect(harness.memory.initialize).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(harness.memory.enforceStorageBudget).toHaveBeenCalledTimes(1);
    expect(harness.memory.repairStaleEmbeddings).not.toHaveBeenCalled();
    expect(harness.memoryHealth.snapshot()).toEqual(
      expect.objectContaining({
        state: 'idle',
        consecutiveFailures: 0,
      }),
    );

    await harness.work.shutdown();
  });
});
