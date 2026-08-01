// 聚合系统与系统事件诊断快照，并统一处理刷新、缓存和失败状态。
import { create } from 'zustand';
import {
  diagnosticsApi,
  type SystemEventDiagnosticsResult,
} from '../api/diagnostic.js';
import { systemApi, type SystemInfoWire } from '../api/system.js';

const DIAGNOSTICS_CACHE_TTL_MS = 30_000;

export interface DiagnosticsSnapshot {
  capturedAt: number;
  system: SystemInfoWire;
  systemEvents: SystemEventDiagnosticsResult;
}

export type DiagnosticsLoadStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

export interface DiagnosticsStoreState {
  snapshot: DiagnosticsSnapshot | null;
  status: DiagnosticsLoadStatus;
  error: string | null;
  load(force?: boolean): Promise<void>;
}

let activeLoad: Promise<void> | null = null;

export function serializeDiagnosticsSnapshot(snapshot: DiagnosticsSnapshot): string {
  return JSON.stringify({
    schemaVersion: 1,
    capturedAt: new Date(snapshot.capturedAt).toISOString(),
    system: snapshot.system,
    systemEvents: snapshot.systemEvents,
  }, null, 2);
}

export const useDiagnosticsStore = create<DiagnosticsStoreState>((set, get) => ({
  snapshot: null,
  status: 'idle',
  error: null,

  load(force = false) {
    const current = get();
    const cacheIsFresh = current.snapshot
      && Date.now() - current.snapshot.capturedAt < DIAGNOSTICS_CACHE_TTL_MS;
    if (!force && cacheIsFresh) return Promise.resolve();
    if (activeLoad) return activeLoad;

    set({ status: 'loading', error: null });
    const request = Promise.all([
      systemApi.getInfo(),
      diagnosticsApi.systemEvents(),
    ])
      .then(([system, systemEvents]) => {
        set({
          snapshot: { capturedAt: Date.now(), system, systemEvents },
          status: 'ready',
          error: null,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '加载系统诊断失败';
        set((state) => ({
          status: state.snapshot ? 'stale' : 'error',
          error: message,
        }));
        throw error;
      })
      .finally(() => {
        if (activeLoad === request) activeLoad = null;
      });

    activeLoad = request;
    return request;
  },
}));
