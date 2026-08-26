// 聚合系统与系统事件诊断报告，并统一处理刷新、缓存和失败状态。
import { create } from 'zustand';
import {
  systemApi,
  type DisksInfo,
  type EventsDiagnostics,
} from '../api/system.js';

const DIAGNOSTICS_CACHE_TTL_MS = 30_000;

export interface DiagnosticsReport {
  capturedAt: number;
  system: DisksInfo;
  systemEvents: EventsDiagnostics;
}

export type DiagnosticsLoadStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

export interface DiagnosticsStoreState {
  report: DiagnosticsReport | null;
  status: DiagnosticsLoadStatus;
  error: string | null;
  load(force?: boolean): Promise<void>;
}

let activeLoad: Promise<void> | null = null;

export function serializeDiagnosticsReport(report: DiagnosticsReport): string {
  return JSON.stringify({
    schemaVersion: 1,
    capturedAt: new Date(report.capturedAt).toISOString(),
    system: report.system,
    systemEvents: report.systemEvents,
  }, null, 2);
}

export const useDiagnosticsStore = create<DiagnosticsStoreState>((set, get) => ({
  report: null,
  status: 'idle',
  error: null,

  load(force = false) {
    const current = get();
    const cacheIsFresh = current.report
      && Date.now() - current.report.capturedAt < DIAGNOSTICS_CACHE_TTL_MS;
    if (!force && cacheIsFresh) return Promise.resolve();
    if (activeLoad) return activeLoad;

    set({ status: 'loading', error: null });
    const request = Promise.all([
      systemApi.getDisks(),
      systemApi.eventsDiagnostics(),
    ])
      .then(([system, systemEvents]) => {
        set({
          report: { capturedAt: Date.now(), system, systemEvents },
          status: 'ready',
          error: null,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '加载系统诊断失败';
        set((state) => ({
          status: state.report ? 'stale' : 'error',
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
