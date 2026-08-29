// Server 可用状态：端口发现 + 健康轮询。
import { create } from 'zustand';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { systemApi } from '../api/system.js';

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type ServerStatus =
  | { kind: 'unknown' }
  | { kind: 'pending' }
  | { kind: 'ok'; port: number; latencyMs: number }
  | { kind: 'error'; reason: string };

export interface ServerStoreState {
  status:        ServerStatus;
  lastKnownPort: number | null;

  refresh():         Promise<void>;
  startPolling(intervalMs?: number): () => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

let refreshInFlight: Promise<void> | null = null;

export const useServerStore = create<ServerStoreState>((set, get) => ({
  status:        { kind: 'unknown' },
  lastKnownPort: null,

  refresh() {
    if (refreshInFlight) return refreshInFlight;

    const run = async (): Promise<void> => {
      const currentStatus = get().status;
      set({
        // pending 只表示首次连接；已建立连接后的复检不卸载任何业务 UI。
        ...(currentStatus.kind === 'unknown' ? { status: { kind: 'pending' } as ServerStatus } : {}),
      });

      try {
        const port = await tauriBridge.getServerPort();
        const effectivePort = (typeof port === 'number' && port > 0) ? port : 3421;

        const start = performance.now();
        await systemApi.health();
        const latencyMs = Math.round(performance.now() - start);

        set({
          status:        { kind: 'ok', port: effectivePort, latencyMs },
          lastKnownPort: effectivePort,
        });
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : '未知错误';
        set({
          status: { kind: 'error', reason },
        });
      }
    };

    refreshInFlight = run().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  },

  startPolling(intervalMs = 5000): () => void {
    let fastMode = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      void get().refresh().then(() => {
        const s = get().status;
        // 健康后降到 30s 慢轮询；出错回到 5s 快轮询。
        if (s.kind === 'ok' && fastMode) {
          fastMode = false;
          if (timer) clearInterval(timer);
          timer = setInterval(tick, 30_000);
        }
        if (s.kind === 'error' && !fastMode) {
          fastMode = true;
          if (timer) clearInterval(timer);
          timer = setInterval(tick, 5_000);
        }
      });
    };

    timer = setInterval(tick, intervalMs);
    // 立即执行第一轮。
    void get().refresh();

    return () => {
      if (timer) clearInterval(timer);
    };
  },
}));
