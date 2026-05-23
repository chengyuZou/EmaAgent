/**
 * Sidecar store — port discovery + health polling.
 */
import { create } from 'zustand';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { sidecarClient } from '../api/sidecar-client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SidecarStatus =
  | { kind: 'unknown' }
  | { kind: 'pending' }
  | { kind: 'ok'; port: number; latencyMs: number }
  | { kind: 'error'; reason: string };

export interface SidecarStoreState {
  status:        SidecarStatus;
  lastKnownPort: number | null;

  refresh():         Promise<void>;
  startPolling(intervalMs?: number): () => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSidecarStore = create<SidecarStoreState>((set, get) => ({
  status:        { kind: 'unknown' },
  lastKnownPort: null,

  async refresh() {
    set({ status: { kind: 'pending' } });

    try {
      const port = await tauriBridge.invoke<number>('get_sidecar_port');
      const effectivePort = (typeof port === 'number' && port > 0) ? port : 3421;

      const start = performance.now();
      const res = await fetch(`http://127.0.0.1:${effectivePort}/health`);
      const latencyMs = Math.round(performance.now() - start);

      if (res.ok) {
        set({
          status:        { kind: 'ok', port: effectivePort, latencyMs },
          lastKnownPort: effectivePort,
        });
      } else {
        set({
          status: { kind: 'error', reason: `Health returned ${res.status}` },
        });
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'Unknown error';
      set({ status: { kind: 'error', reason } });
    }
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
