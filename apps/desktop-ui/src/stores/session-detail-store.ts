import { create } from 'zustand';
import { sessionsApi } from '../api/sessions.js';
import type { SessionDashboardWire } from '../api/sessions.js';
import type { SessionId } from '@ema-agent/contracts';

interface SessionDetailState {
  dashboardBySession: Map<string, SessionDashboardWire>;
  loadingSet:         Set<string>;
  errorBySession:     Map<string, string>;

  loadDashboard(sessionId: SessionId): Promise<void>;
  clearSession(sessionId: SessionId): void;
  getError(sessionId: SessionId): string | null;
  isLoading(sessionId: SessionId): boolean;
}

export const useSessionDetailStore = create<SessionDetailState>((set, get) => ({
  dashboardBySession: new Map(),
  loadingSet:         new Set(),
  errorBySession:     new Map(),

  isLoading: (id) => get().loadingSet.has(id),
  getError:  (id) => get().errorBySession.get(id) ?? null,

  async loadDashboard(sessionId) {
    if (get().loadingSet.has(sessionId)) return;

    set((s) => ({
      loadingSet:     new Set([...s.loadingSet, sessionId]),
      errorBySession: (() => { const m = new Map(s.errorBySession); m.delete(sessionId); return m; })(),
    }));

    try {
      const dashboard = await sessionsApi.getDashboard(sessionId);
      set((s) => {
        const m = new Map(s.dashboardBySession);
        m.set(sessionId, dashboard);
        const l = new Set(s.loadingSet);
        l.delete(sessionId);
        return { dashboardBySession: m, loadingSet: l };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败';
      set((s) => {
        const e = new Map(s.errorBySession);
        e.set(sessionId, msg);
        const l = new Set(s.loadingSet);
        l.delete(sessionId);
        return { errorBySession: e, loadingSet: l };
      });
    }
  },

  clearSession(sessionId) {
    set((s) => {
      const d = new Map(s.dashboardBySession); d.delete(sessionId);
      const e = new Map(s.errorBySession);     e.delete(sessionId);
      const l = new Set(s.loadingSet);         l.delete(sessionId);
      return { dashboardBySession: d, errorBySession: e, loadingSet: l };
    });
  },
}));
