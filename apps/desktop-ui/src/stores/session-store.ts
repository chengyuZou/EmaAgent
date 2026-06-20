import { create } from 'zustand';
import { sessionsApi, type SessionWire } from '../api/sessions.js';
import { useConversationStore } from './conversation-store.js';
import type { SessionId, TurnMode } from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionsState {
  pinned:   SessionWire[];
  byGroup:  Array<{ label: string; sessions: SessionWire[] }>;
  recent:   SessionWire[];
  archived: SessionWire[];
  byId:     Map<string, SessionWire>;
}

export interface SessionStoreState {
  sessions:     SessionsState;
  sessionModes: Map<string, { mode: TurnMode }>;
  loading:      boolean;
  error:        string | null;

  loadSessions():                                                    Promise<void>;
  createSession():                                                   Promise<SessionId>;
  renameSession(id: SessionId, title: string):                       Promise<void>;
  pinSession(id: SessionId, pinned: boolean):                        Promise<void>;
  setSessionGroup(id: SessionId, label: string | null):              Promise<void>;
  setWorkspaceRoots(id: SessionId, paths: string[]):                 Promise<void>;
  setSessionMode(id: SessionId, mode: TurnMode): Promise<void>;
  forkSession(id: SessionId):                                        Promise<SessionId>;
  archiveSession(id: SessionId):                                     Promise<void>;
  unarchiveSession(id: SessionId):                                   Promise<void>;
  deleteSession(id: SessionId):                                      Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptySessions(): SessionsState {
  return { pinned: [], byGroup: [], recent: [], archived: [], byId: new Map() };
}

function rebuildById(s: SessionsState): void {
  s.byId = new Map();
  for (const x of s.pinned)   s.byId.set(x.id, x);
  for (const g of s.byGroup)  for (const x of g.sessions) s.byId.set(x.id, x);
  for (const x of s.recent)   s.byId.set(x.id, x);
  for (const x of s.archived) s.byId.set(x.id, x);
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions:     emptySessions(),
  sessionModes: new Map(),
  loading:      false,
  error:        null,

  async loadSessions() {
    set({ loading: true, error: null });
    try {
      const grouped = await sessionsApi.listGrouped();
      const sessions: SessionsState = {
        pinned:   grouped.pinned,
        byGroup:  grouped.byGroup,
        recent:   grouped.recent,
        archived: grouped.archived,
        byId:     new Map(),
      };
      rebuildById(sessions);
      set({ sessions, loading: false });
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to load sessions', loading: false });
    }
  },

  async createSession() {
    try {
      const session = await sessionsApi.create();
      await get().loadSessions();
      return session.id as SessionId;
    } catch {
      return null as unknown as SessionId;
    }
  },

  async renameSession(id, title) {
    try {
      await sessionsApi.patch(id, { title });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to rename session' });
    }
  },

  async pinSession(id, pinned) {
    try {
      await sessionsApi.patch(id, { pinned });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to pin session' });
    }
  },

  async setSessionGroup(id, label) {
    try {
      await sessionsApi.patch(id, { groupLabel: label });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to set group' });
    }
  },

  async setWorkspaceRoots(id, paths) {
    try {
      await sessionsApi.patch(id, { workspaceRoots: paths });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to set workspace roots' });
    }
  },

  async setSessionMode(id, mode) {
    set((s) => ({
      sessionModes: new Map(s.sessionModes).set(id as string, { mode }),
    }));
    try {
      await sessionsApi.patch(id, { lastMode: mode });
      set((s) => {
        const existing = s.sessions.byId.get(id as string);
        if (!existing) return {};
        const byId = new Map(s.sessions.byId);
        byId.set(id as string, { ...existing, lastMode: mode });
        return { sessions: { ...s.sessions, byId } };
      });
    } catch {
      // mode preference is not critical — silent failure is fine
    }
  },

  async forkSession(id) {
    try {
      const result = await sessionsApi.fork(id);
      await get().loadSessions();
      return result.sessionId as SessionId;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to fork session' });
      throw err;
    }
  },

  async archiveSession(id) {
    try {
      await sessionsApi.archive(id);
      useConversationStore.getState().evictSession(id);
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to archive session' });
    }
  },

  async unarchiveSession(id) {
    try {
      await sessionsApi.unarchive(id);
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to unarchive session' });
    }
  },

  async deleteSession(id) {
    try {
      await sessionsApi.delete(id);
      useConversationStore.getState().evictSession(id);
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete session' });
    }
  },
}));
