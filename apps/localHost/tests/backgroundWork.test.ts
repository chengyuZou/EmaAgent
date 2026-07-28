// 测试 LocalHost 后台生命周期只启动一次、按周期探测 Bridge，并有序排空资源。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundWork } from '../src/background/backgroundWork.js';

function createHarness() {
  const startupRecovery = { run: vi.fn() };
  const memory = {
    initialize: vi.fn(async () => ({ nodes: 0, items: 0, backend: null })),
    tick: vi.fn(async () => undefined),
    drain: vi.fn(async () => undefined),
  };
  const mcp = {
    primeFromCache: vi.fn(() => 0),
    startAll: vi.fn(async () => undefined),
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

  const work = new BackgroundWork(
    startupRecovery,
    memory,
    mcp,
    toolResults,
    attachmentCache,
    narrative,
    providerRuntime,
    systemEvents,
  );

  return {
    work,
    startupRecovery,
    memory,
    mcp,
    toolResults,
    attachmentCache,
    narrative,
    providerRuntime,
    systemEvents,
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

    expect(harness.startupRecovery.run).toHaveBeenCalledTimes(1);
    expect(harness.memory.initialize).toHaveBeenCalledTimes(1);
    expect(harness.mcp.primeFromCache).toHaveBeenCalledTimes(1);
    expect(harness.mcp.startAll).toHaveBeenCalledTimes(1);

    await harness.work.shutdown();
    await harness.work.shutdown();

    expect(harness.memory.drain).toHaveBeenCalledTimes(1);
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
});
