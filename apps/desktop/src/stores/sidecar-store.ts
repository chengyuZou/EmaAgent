/**
 * Sidecar store — port discovery + health polling.
 */
import { create } from 'zustand';
import { tauriBridge } from '../lib/tauri-bridge.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SidecarStatus =
  | { kind: 'unknown' }
  | { kind: 'pending' }
  | { kind: 'ok'; port: number; latencyMs: number }
  | { kind: 'error'; reason: string };

export interface SidecarStoreState {
  status:        SidecarStatus;
  lastKnownPort: number | null;
  /** 后台健康检查正在执行；不会把已连接状态降成 pending。 */
  checking: boolean;
  lastCheckedAt: number | null;
  consecutiveFailures: number;

  refresh():         Promise<void>;
  startPolling(intervalMs?: number): () => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

const HEALTH_TIMEOUT_MS = 5_000;
let refreshInFlight: Promise<void> | null = null;

export const useSidecarStore = create<SidecarStoreState>((set, get) => ({
  status:        { kind: 'unknown' },
  lastKnownPort: null,
  checking: false,
  lastCheckedAt: null,
  consecutiveFailures: 0,

  refresh() {
    if (refreshInFlight) return refreshInFlight;

    const run = async (): Promise<void> => {
      const currentStatus = get().status;
      set({
        checking: true,
        // pending 只表示首次连接；已建立连接后的复检不卸载任何业务 UI。
        ...(currentStatus.kind === 'unknown' ? { status: { kind: 'pending' } as SidecarStatus } : {}),
      });

      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      try {
        const port = await tauriBridge.invoke<number>('get_sidecar_port');
        const effectivePort = (typeof port === 'number' && port > 0) ? port : 3421;

        const start = performance.now();
        const res = await fetch(`http://127.0.0.1:${effectivePort}/health`, {
          signal: controller.signal,
        });
        const latencyMs = Math.round(performance.now() - start);

        if (!res.ok) throw new Error(`Health returned ${res.status}`);

        set({
          status:        { kind: 'ok', port: effectivePort, latencyMs },
          lastKnownPort: effectivePort,
          checking: false,
          lastCheckedAt: Date.now(),
          consecutiveFailures: 0,
        });
      } catch (err: unknown) {
        const reason = controller.signal.aborted
          ? `Health check timed out after ${HEALTH_TIMEOUT_MS}ms`
          : err instanceof Error ? err.message : 'Unknown error';
        set({
          status: { kind: 'error', reason },
          checking: false,
          lastCheckedAt: Date.now(),
          consecutiveFailures: get().consecutiveFailures + 1,
        });
      } finally {
        globalThis.clearTimeout(timeout);
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
        // Slow down to 30s once healthy
        if (s.kind === 'ok' && fastMode) {
          fastMode = false;
          if (timer) clearInterval(timer);
          timer = setInterval(tick, 30_000);
        }
        // Speed up on error
        if (s.kind === 'error' && !fastMode) {
          fastMode = true;
          if (timer) clearInterval(timer);
          timer = setInterval(tick, 5_000);
        }
      });
    };

    timer = setInterval(tick, intervalMs);
    // Run first tick immediately
    void get().refresh();

    return () => {
      if (timer) clearInterval(timer);
    };
  },
}));
