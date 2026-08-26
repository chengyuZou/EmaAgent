// 管理前端 Session 列表、工作区、模式和下一轮模型偏好。
import { create } from 'zustand';
import { sessionsApi, type SessionsGrouped } from '../api/sessions.js';
import { useBackgroundProcessStore } from './backgroundProcessStore.js';
import { useContextUsageStore } from './contextUsageStore.js';
import { useConversationStore } from './conversation-store.js';
import { useDecisionStore } from './decision-store.js';

import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/session';

// ── Types ─────────────────────────────────────────────────────────────────────

/** 侧栏列表条目（Session + hasActiveTurn/lastTurnStatus/hasUnread 列表投影）。 */
export type SessionListEntry = SessionsGrouped['recent'][number];
/** 项目槽：实体 + 文件夹 + 成员 Session。 */
export type SessionProjectGroup = SessionsGrouped['projects'][number];

/** Session 下一轮模型偏好；null 恢复默认解析。 */
export interface SessionModelPreference {
  providerId: string;
  modelId: string;
}

export interface SessionsState {
  pinned:   SessionListEntry[];
  pinnedProjects: SessionProjectGroup[];
  projects: SessionProjectGroup[];
  recent:   SessionListEntry[];
  archived: SessionListEntry[];
  byId:     Map<string, SessionListEntry>;
}

export interface SessionStoreState {
  sessions:     SessionsState;
  loading:      boolean;
  error:        string | null;

  loadSessions():                                                    Promise<void>;
  createSession():                                                   Promise<string>;
  renameSession(id: string, title: string):                       Promise<void>;
  pinSession(id: string, pinned: boolean):                        Promise<void>;
  setWorkspaceRoot(id: string, path: string | null):              Promise<void>;
  setExecutionSettings(
    id: string,
    patch: {
      executionProfile?: ExecutionProfile;
      narrativePolicy?: NarrativePolicy;
    },
  ): Promise<void>;
  /** 保存用户希望该 Session 下一轮使用的供应商配置和模型。 */
  setPreferredModel(
    id: string,
    model: SessionModelPreference | null,
  ): Promise<void>;
  forkSession(id: string, untilTurnId?: string):                   Promise<string>;
  archiveSession(id: string):                                     Promise<void>;
  unarchiveSession(id: string):                                   Promise<void>;
  deleteSession(id: string):                                      Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptySessions(): SessionsState {
  return { pinned: [], pinnedProjects: [], projects: [], recent: [], archived: [], byId: new Map() };
}

function rebuildById(s: SessionsState): void {
  s.byId = new Map();
  for (const x of s.pinned)   s.byId.set(x.id, x);
  for (const g of s.pinnedProjects) for (const x of g.sessions) s.byId.set(x.id, x);
  for (const g of s.projects)       for (const x of g.sessions) s.byId.set(x.id, x);
  for (const x of s.recent)   s.byId.set(x.id, x);
  for (const x of s.archived) s.byId.set(x.id, x);
}

function replaceSession(
  sessions: SessionsState,
  id: string,
  replacement: SessionListEntry,
): SessionsState {
  const replace = (session: SessionListEntry): SessionListEntry =>
    session.id === id ? replacement : session;
  const replaceGroup = (group: SessionProjectGroup): SessionProjectGroup => ({
    ...group,
    sessions: group.sessions.map(replace),
  });
  const next: SessionsState = {
    pinned: sessions.pinned.map(replace),
    pinnedProjects: sessions.pinnedProjects.map(replaceGroup),
    projects: sessions.projects.map(replaceGroup),
    recent: sessions.recent.map(replace),
    archived: sessions.archived.map(replace),
    byId: new Map(sessions.byId),
  };
  next.byId.set(id, replacement);
  return next;
}

// 同一 Session 的偏好写入必须按用户点击顺序落库，旧响应也不能覆盖新选择。
const preferredModelWriteChains = new Map<string, Promise<void>>();
const preferredModelGenerations = new Map<string, number>();
const executionSettingsWriteChains = new Map<string, Promise<void>>();
const executionSettingsGenerations = new Map<string, number>();

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions:     emptySessions(),
  loading:      false,
  error:        null,

  async loadSessions() {
    set({ loading: true, error: null });
    try {
      const grouped = await sessionsApi.listGrouped();
      const sessions: SessionsState = {
        pinned:   [...grouped.pinned],
        pinnedProjects: [...grouped.pinnedProjects],
        projects: [...grouped.projects],
        recent:   [...grouped.recent],
        archived: [...grouped.archived],
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
      return session.id;
    } catch (error: unknown) {
      set({
        error: error instanceof Error ? error.message : 'Failed to create session',
      });
      throw error;
    }
  },

  async renameSession(id, title) {
    try {
      await sessionsApi.patch(id, { title });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to rename session' });
      throw err;
    }
  },

  async pinSession(id, pinned) {
    try {
      await sessionsApi.patch(id, { pinned });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to pin session' });
      throw err;
    }
  },

  async setWorkspaceRoot(id, path) {
    try {
      await sessionsApi.patch(id, { workspaceRoot: path });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to set workspace root' });
      throw err;
    }
  },

  async setExecutionSettings(id, patch) {
    const key = id as string;
    const previous = get().sessions.byId.get(key);
    if (!previous) throw new Error(`Session not loaded: ${key}`);

    const generation = (executionSettingsGenerations.get(key) ?? 0) + 1;
    executionSettingsGenerations.set(key, generation);
    const optimistic: SessionListEntry = {
      ...previous,
      executionProfile: patch.executionProfile ?? previous.executionProfile,
      narrativePolicy: patch.narrativePolicy ?? previous.narrativePolicy,
    };
    set((state) => ({
      sessions: replaceSession(state.sessions, key, optimistic),
      error: null,
    }));

    const previousWrite = executionSettingsWriteChains.get(key) ?? Promise.resolve();
    let currentWrite!: Promise<void>;
    currentWrite = previousWrite
      .catch(() => {})
      .then(async () => {
        const updated = await sessionsApi.patch(id, patch);
        if (executionSettingsGenerations.get(key) !== generation) return;
        set((state) => {
          const current = state.sessions.byId.get(key);
          if (!current) return {};
          return {
            sessions: replaceSession(state.sessions, key, {
              ...current,
              executionProfile: updated.executionProfile,
              narrativePolicy: updated.narrativePolicy,
            }),
          };
        });
      })
      .catch((error: unknown) => {
        if (executionSettingsGenerations.get(key) !== generation) return;
        set((state) => {
          const current = state.sessions.byId.get(key);
          if (!current) return {};
          return {
            sessions: replaceSession(state.sessions, key, {
              ...current,
              executionProfile: previous.executionProfile,
              narrativePolicy: previous.narrativePolicy,
            }),
            error: error instanceof Error ? error.message : '保存执行设置失败',
          };
        });
        throw error;
      })
      .finally(() => {
        if (executionSettingsWriteChains.get(key) === currentWrite) {
          executionSettingsWriteChains.delete(key);
        }
      });
    executionSettingsWriteChains.set(key, currentWrite);
    return currentWrite;
  },

  async setPreferredModel(id, model) {
    const key = id as string;
    const previous = get().sessions.byId.get(key);
    if (!previous) throw new Error(`Session not loaded: ${key}`);
    const generation = (preferredModelGenerations.get(key) ?? 0) + 1;
    preferredModelGenerations.set(key, generation);

    const optimistic: SessionListEntry = {
      ...previous,
      providerId: model?.providerId ?? null,
      modelId: model?.modelId ?? null,
    };
    set((state) => ({
      sessions: replaceSession(state.sessions, key, optimistic),
      error: null,
    }));

    const previousWrite = preferredModelWriteChains.get(key) ?? Promise.resolve();
    let currentWrite!: Promise<void>;
    currentWrite = previousWrite
      .catch(() => {})
      .then(async () => {
        const updated = await sessionsApi.patch(id, { model });
        if (preferredModelGenerations.get(key) !== generation) return;
        set((state) => {
          const current = state.sessions.byId.get(key);
          if (!current) return {};
          return {
            sessions: replaceSession(state.sessions, key, {
              ...current,
              providerId: updated.providerId,
              modelId: updated.modelId,
            }),
          };
        });
      })
      .catch((error: unknown) => {
        // 已有更新选择时，旧请求失败不能回滚或向当前 UI 报错。
        if (preferredModelGenerations.get(key) !== generation) return;
        set((state) => {
          const current = state.sessions.byId.get(key);
          if (!current) return {};
          return {
            sessions: replaceSession(state.sessions, key, {
              ...current,
              providerId: previous.providerId,
              modelId: previous.modelId,
            }),
            error: error instanceof Error ? error.message : '保存 Session 模型失败',
          };
        });
        throw error;
      })
      .finally(() => {
        if (preferredModelWriteChains.get(key) === currentWrite) {
          preferredModelWriteChains.delete(key);
        }
      });
    preferredModelWriteChains.set(key, currentWrite);
    return currentWrite;
  },

  async forkSession(id, untilTurnId) {
    try {
      const result = await sessionsApi.fork(id, untilTurnId);
      await get().loadSessions();
      return result.sessionId;
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
      throw err;
    }
  },

  async unarchiveSession(id) {
    try {
      await sessionsApi.unarchive(id);
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to unarchive session' });
      throw err;
    }
  },

  async deleteSession(id) {
    try {
      await sessionsApi.delete(id);
      useConversationStore.getState().evictSession(id);
      useDecisionStore.getState().clearSession(id);
      // Session 永久删除后,进程面板缓存与跟随循环一并清理,不显示其他 Session 的进程。
      useBackgroundProcessStore.getState().clearSession(id as string);
      useContextUsageStore.getState().clearSession(id as string);
      preferredModelWriteChains.delete(id as string);
      preferredModelGenerations.delete(id as string);
      executionSettingsWriteChains.delete(id as string);
      executionSettingsGenerations.delete(id as string);
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete session' });
      throw err;
    }
  },
}));
