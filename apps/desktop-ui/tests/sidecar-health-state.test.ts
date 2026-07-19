// 测试健康复检不把已连接 UI 降成 pending，并保留断线前的连接上下文。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriBridge } from '../src/lib/tauri-bridge.js';
import { useSidecarStore } from '../src/stores/sidecar-store.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function resetStore(): void {
  useSidecarStore.setState({
    status: { kind: 'unknown' },
    lastKnownPort: null,
    checking: false,
    lastCheckedAt: null,
    consecutiveFailures: 0,
  });
}

describe('Sidecar health 状态', () => {
  beforeEach(() => {
    resetStore();
    vi.spyOn(tauriBridge, 'invoke').mockResolvedValue(3421);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('首次连接期间使用 pending，成功后记录稳定连接', async () => {
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));

    const refresh = useSidecarStore.getState().refresh();
    expect(useSidecarStore.getState()).toMatchObject({
      status: { kind: 'pending' },
      checking: true,
    });

    response.resolve(new Response(null, { status: 200 }));
    await refresh;
    expect(useSidecarStore.getState()).toMatchObject({
      status: { kind: 'ok', port: 3421 },
      lastKnownPort: 3421,
      checking: false,
      consecutiveFailures: 0,
    });
  });

  it('后台复检期间保持 ok，不触发聊天输入区卸载', async () => {
    useSidecarStore.setState({
      status: { kind: 'ok', port: 3421, latencyMs: 8 },
      lastKnownPort: 3421,
    });
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));

    const refresh = useSidecarStore.getState().refresh();
    expect(useSidecarStore.getState()).toMatchObject({
      status: { kind: 'ok', port: 3421, latencyMs: 8 },
      checking: true,
    });

    response.resolve(new Response(null, { status: 200 }));
    await refresh;
  });

  it('已连接后的失败保留 lastKnownPort，供聊天树留在页面上', async () => {
    useSidecarStore.setState({
      status: { kind: 'ok', port: 3421, latencyMs: 8 },
      lastKnownPort: 3421,
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));

    await useSidecarStore.getState().refresh();

    expect(useSidecarStore.getState()).toMatchObject({
      status: { kind: 'error', reason: 'connection refused' },
      lastKnownPort: 3421,
      checking: false,
      consecutiveFailures: 1,
    });
  });
});
