// 测试 LocalHost 后台生命周期只启动一次、按周期探测 Bridge，并有序排空资源。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundWork } from '../src/background/backgroundWork.js';

function createHarness() {
  const startupRecovery = {
    runRequired: vi.fn(),
    runMaintenance: vi.fn(() => ({ memoryReady: true })),
  };
  const memory = {
    initialize: vi.fn(async () => ({ nodes: 0, items: 0, backend: null })),
    tick: vi.fn(async () => undefined),
    drain: vi.fn(async () => undefined),
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
});
