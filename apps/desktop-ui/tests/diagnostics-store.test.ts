// 测试诊断快照的接口聚合、短期缓存、强制刷新和失败时保留旧数据。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnosticsApi, type HookDiagnosticsResult } from '../src/api/diagnostic.js';
import { systemApi, type SystemInfoWire } from '../src/api/system.js';
import {
  serializeDiagnosticsSnapshot,
  useDiagnosticsStore,
} from '../src/stores/diagnostics-store.js';

const system: SystemInfoWire = {
  dataDir: 'D:\\EmaData',
  disks: [{ mount: 'D:\\', label: 'Data', total: 1000, free: 400 }],
};

const hooks: HookDiagnosticsResult = {
  traces: [],
  totalCaptured: 2,
  summary: { continue: 1, replace: 0, abort: 0, error: 1 },
  failures: [],
  slowest: [],
};

beforeEach(() => {
  useDiagnosticsStore.setState({ snapshot: null, status: 'idle', error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Diagnostics store', () => {
  it('并行聚合三个诊断接口并形成同一快照', async () => {
    vi.spyOn(systemApi, 'getInfo').mockResolvedValue(system);
    vi.spyOn(diagnosticsApi, 'systemEvents').mockResolvedValue({ subscribers: 2 });
    vi.spyOn(diagnosticsApi, 'hooks').mockResolvedValue(hooks);

    await useDiagnosticsStore.getState().load();

    expect(useDiagnosticsStore.getState()).toMatchObject({
      status: 'ready',
      error: null,
      snapshot: { system, systemEvents: { subscribers: 2 }, hooks },
    });
  });

  it('新鲜快照直接复用，强制刷新才重新请求', async () => {
    const getInfo = vi.spyOn(systemApi, 'getInfo').mockResolvedValue(system);
    vi.spyOn(diagnosticsApi, 'systemEvents').mockResolvedValue({ subscribers: 1 });
    vi.spyOn(diagnosticsApi, 'hooks').mockResolvedValue(hooks);

    await useDiagnosticsStore.getState().load();
    await useDiagnosticsStore.getState().load();
    expect(getInfo).toHaveBeenCalledOnce();

    await useDiagnosticsStore.getState().load(true);
    expect(getInfo).toHaveBeenCalledTimes(2);
  });

  it('刷新失败时保留旧快照并标记 stale', async () => {
    vi.spyOn(systemApi, 'getInfo')
      .mockResolvedValueOnce(system)
      .mockRejectedValueOnce(new Error('system offline'));
    vi.spyOn(diagnosticsApi, 'systemEvents').mockResolvedValue({ subscribers: 1 });
    vi.spyOn(diagnosticsApi, 'hooks').mockResolvedValue(hooks);

    await useDiagnosticsStore.getState().load();
    const previous = useDiagnosticsStore.getState().snapshot;
    await expect(useDiagnosticsStore.getState().load(true)).rejects.toThrow('system offline');

    expect(useDiagnosticsStore.getState()).toMatchObject({
      snapshot: previous,
      status: 'stale',
      error: 'system offline',
    });
  });

  it('复制报告包含版本和三类结构化诊断数据', () => {
    const report = serializeDiagnosticsSnapshot({
      capturedAt: Date.parse('2026-07-19T00:00:00.000Z'),
      system,
      systemEvents: { subscribers: 1 },
      hooks,
    });

    expect(JSON.parse(report)).toMatchObject({
      schemaVersion: 1,
      capturedAt: '2026-07-19T00:00:00.000Z',
      system,
      systemEvents: { subscribers: 1 },
      hooks,
    });
  });
});
