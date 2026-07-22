// 管理按 Session 隔离的附件列表、刷新状态与异步响应竞态。
import { create } from 'zustand';
import type { SessionId } from '@ema-agent/ids';
import type { SessionAttachmentWire } from '@ema-agent/session';
import { sessionsApi } from '../api/sessions.js';

export type SessionAttachmentLoadState =
  | { status: 'idle'; generation: number; error: null }
  | { status: 'loading'; generation: number; error: null }
  | { status: 'ready'; generation: number; error: null; loadedAt: number }
  | { status: 'stale'; generation: number; error: string; loadedAt?: number }
  | { status: 'error'; generation: number; error: string };

export interface SessionAttachmentStoreState {
  bySession: Map<string, SessionAttachmentWire[]>;
  loadStateBySession: Map<string, SessionAttachmentLoadState>;
  loadForSession(sessionId: SessionId, force?: boolean): Promise<void>;
  evictSession(sessionId: SessionId): void;
}

const inFlightLoads = new Map<string, {
  generation: number;
  requestId: symbol;
  promise: Promise<void>;
}>();

function generationOf(state: SessionAttachmentStoreState, sessionId: string): number {
  return state.loadStateBySession.get(sessionId)?.generation ?? 0;
}

export const useSessionAttachmentStore = create<SessionAttachmentStoreState>((set, get) => ({
  bySession: new Map(),
  loadStateBySession: new Map(),

  loadForSession(sessionId, force = false) {
    const key = sessionId as string;
    const current = get();
    const previous = current.loadStateBySession.get(key);
    if (!force && previous?.status === 'ready') return Promise.resolve();

    const generation = force ? (previous?.generation ?? 0) + 1 : previous?.generation ?? 0;
    const running = inFlightLoads.get(key);
    if (!force && running?.generation === generation) return running.promise;
    const requestId = Symbol(key);

    set((state) => {
      const loadStates = new Map(state.loadStateBySession);
      loadStates.set(key, { status: 'loading', generation, error: null });
      return { loadStateBySession: loadStates };
    });

    const promise = sessionsApi.listAttachments(sessionId)
      .then(({ attachments }) => {
        if (inFlightLoads.get(key)?.requestId !== requestId) return;
        set((state) => {
          if (generationOf(state, key) !== generation) return {};
          const bySession = new Map(state.bySession);
          const loadStates = new Map(state.loadStateBySession);
          bySession.set(key, attachments);
          loadStates.set(key, {
            status: 'ready',
            generation,
            error: null,
            loadedAt: Date.now(),
          });
          return { bySession, loadStateBySession: loadStates };
        });
      })
      .catch((error: unknown) => {
        if (inFlightLoads.get(key)?.requestId !== requestId) return;
        set((state) => {
          if (generationOf(state, key) !== generation) return {};
          const message = error instanceof Error ? error.message : '加载会话附件失败';
          const loadStates = new Map(state.loadStateBySession);
          loadStates.set(key, state.bySession.has(key)
            ? {
                status: 'stale',
                generation,
                error: message,
                ...(previous && 'loadedAt' in previous ? { loadedAt: previous.loadedAt } : {}),
              }
            : { status: 'error', generation, error: message });
          return { loadStateBySession: loadStates };
        });
        throw error;
      })
      .finally(() => {
        if (inFlightLoads.get(key)?.requestId === requestId) inFlightLoads.delete(key);
      });

    inFlightLoads.set(key, { generation, requestId, promise });
    return promise;
  },

  evictSession(sessionId) {
    const key = sessionId as string;
    inFlightLoads.delete(key);
    set((state) => {
      const bySession = new Map(state.bySession);
      const loadStates = new Map(state.loadStateBySession);
      bySession.delete(key);
      loadStates.delete(key);
      return { bySession, loadStateBySession: loadStates };
    });
  },
}));
