// 管理前端 Session 列表、工作区、模式和下一轮模型偏好。
import { create } from 'zustand';
import {
  sessionsApi,
  type SessionListItem,
  type SessionPatchInput,
  type SessionProjectGroup,
  type SessionsGrouped,
} from '../api/sessions.js';
import { useBackgroundProcessStore } from './backgroundProcess.js';
import { useDecisionStore } from './decision.js';
import { evictChatSession } from '../chat/state/turnRunner.js';
import { useContextUsage } from '../chat/state/contextUsage.js';

import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/session';

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface SessionsState {
  pinned:   SessionListItem[];
  pinnedProjects: SessionProjectGroup[];
  projects: SessionProjectGroup[];
  recent:   SessionListItem[];
  archived: SessionListItem[];
  byId:     Map<string, SessionListItem>;
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
  /** 保存该 Session 后续 Turn 的模型偏好；null 恢复默认解析。 */
  setPreferredModel(
    id: string,
    model: SessionPatchInput['model'],
  ): Promise<void>;
  forkSession(id: string, untilTurnId?: string):                   Promise<string>;
  archiveSession(id: string):                                     Promise<void>;
  unarchiveSession(id: string):                                   Promise<void>;
  deleteSession(id: string):                                      Promise<void>;
}

// ── 辅助 ───────────────────────────────────────────────────────────────────

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
  replacement: SessionListItem,
): SessionsState {
  const replace = (session: SessionListItem): SessionListItem =>
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
      set({ error: err instanceof Error ? err.message : '加载会话列表失败', loading: false });
    }
  },

  async createSession() {
    try {
      const session = await sessionsApi.create();
      await get().loadSessions();
      return session.id;
    } catch (error: unknown) {
      set({
        error: error instanceof Error ? error.message : '创建会话失败',
      });
      throw error;
    }
  },

  async renameSession(id, title) {
    try {
      await sessionsApi.patch(id, { title });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '重命名会话失败' });
      throw err;
    }
  },

  async pinSession(id, pinned) {
    try {
      await sessionsApi.patch(id, { pinned });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '置顶操作失败' });
      throw err;
    }
  },

  async setWorkspaceRoot(id, path) {
    try {
      await sessionsApi.patch(id, { workspaceRoot: path });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '设置工作区失败' });
      throw err;
    }
  },

  async setExecutionSettings(id, patch) {
    const key = id;
    const previous = get().sessions.byId.get(key);
    if (!previous) throw new Error(`Session not loaded: ${key}`);

    const generation = (executionSettingsGenerations.get(key) ?? 0) + 1;
    executionSettingsGenerations.set(key, generation);
    const optimistic: SessionListItem = {
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
    const key = id;
    const previous = get().sessions.byId.get(key);
    if (!previous) throw new Error(`Session not loaded: ${key}`);
    const generation = (preferredModelGenerations.get(key) ?? 0) + 1;
    preferredModelGenerations.set(key, generation);

    const optimistic: SessionListItem = {
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
      set({ error: err instanceof Error ? err.message : '创建分支会话失败' });
      throw err;
    }
  },

  async archiveSession(id) {
    try {
      await sessionsApi.archive(id);
      evictChatSession(id);
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '归档会话失败' });
      throw err;
    }
  },

  async unarchiveSession(id) {
    try {
      await sessionsApi.unarchive(id);
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '取消归档失败' });
      throw err;
    }
  },

  async deleteSession(id) {
    try {
      await sessionsApi.delete(id);
      evictChatSession(id);
      useDecisionStore.getState().clearSession(id);
      // Session 永久删除后,进程面板缓存与跟随循环一并清理,不显示其他 Session 的进程。
      useBackgroundProcessStore.getState().clearSession(id);
      useContextUsage.getState().clearSession(id);
      preferredModelWriteChains.delete(id);
      preferredModelGenerations.delete(id);
      executionSettingsWriteChains.delete(id);
      executionSettingsGenerations.delete(id);
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '删除会话失败' });
      throw err;
    }
  },
}));
