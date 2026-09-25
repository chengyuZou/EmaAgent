// 管理前端 Session 列表、执行目录、模式和下一轮模型偏好。
import { create } from 'zustand';
import {
  sessionsApi,
  type SessionListItem,
  type SessionCreateInput,
  type SessionPatchInput,
  type Project,
} from '../api/sessions.js';
import {
  sidebarApi,
  type ProjectSidebarMoveInput,
  type SessionSidebarMoveInput,
} from '../api/workspaces.js';
import type { SessionMode, NarrativePolicy, ReasoningEffort } from '@ema-agent/session';
import type { PermissionMode } from '@ema-agent/permission';

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface SessionsState {
  pinned:   SessionListItem[];
  pinnedProjects: Project[];
  projects: Project[];
  recent:   SessionListItem[];
  archived: SessionListItem[];
  byId:     Map<string, SessionListItem>;
}

export interface SessionStoreState {
  sessions:     SessionsState;
  loading:      boolean;
  error:        string | null;

  loadSessions():                                                    Promise<void>;
  createSession(input?: SessionCreateInput):                         Promise<string>;
  renameSession(id: string, title: string):                       Promise<void>;
  pinSession(id: string, pinned: boolean):                        Promise<void>;
  moveSessionInSidebar(id: string, input: SessionSidebarMoveInput): Promise<void>;
  moveProjectInSidebar(id: string, input: ProjectSidebarMoveInput): Promise<void>;
  setCwd(id: string, cwd: string):                                  Promise<void>;
  setSessionMode(id: string, sessionMode: SessionMode): Promise<void>;
  setNarrativePolicy(id: string, narrativePolicy: NarrativePolicy): Promise<void>;
  setPermissionMode(id: string, permissionMode: PermissionMode): Promise<void>;
  setTtsEnabled(id: string, ttsEnabled: boolean): Promise<void>;
  /** 模型身份成对保存; 不支持推理的模型在同一请求里把强度设为 off. */
  setModel(id: string, providerId: string, modelId: string, reasoningEffort?: ReasoningEffort): Promise<void>;
  setReasoningEffort(id: string, reasoningEffort: ReasoningEffort): Promise<void>;
  waitForModelSettings(id: string): Promise<void>;
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
  for (const project of s.pinnedProjects) {
    for (const session of project.sessions) {
      s.byId.set(session.id, session);
    }
  }
  for (const project of s.projects) {
    for (const session of project.sessions) {
      s.byId.set(session.id, session);
    }
  }
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
  const replaceProjectSession = (project: Project): Project => ({
    ...project,
    sessions: project.sessions.map(replace),
  });
  const next: SessionsState = {
    pinned: sessions.pinned.map(replace),
    pinnedProjects: sessions.pinnedProjects.map(replaceProjectSession),
    projects: sessions.projects.map(replaceProjectSession),
    recent: sessions.recent.map(replace),
    archived: sessions.archived.map(replace),
    byId: new Map(sessions.byId),
  };
  next.byId.set(id, replacement);
  return next;
}

// 同一 Session 的设置写入按点击顺序落库, 发送前的权限保存也要排在先前选择之后.
const modelSettingsWriteChains = new Map<string, Promise<void>>();
const sessionPreferencesWriteChains = new Map<string, Promise<void>>();
let sessionListRequestId = 0;

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions:     emptySessions(),
  loading:      false,
  error:        null,

  async loadSessions() {
    const requestId = ++sessionListRequestId;
    set({ loading: true, error: null });
    try {
      const sidebarData = await sessionsApi.listForSidebar();
      const sessions: SessionsState = {
        pinned:   [...sidebarData.pinned],
        pinnedProjects: [...sidebarData.pinnedProjects],
        projects: [...sidebarData.projects],
        recent:   [...sidebarData.recent],
        archived: [...sidebarData.archived],
        byId:     new Map(),
      };
      rebuildById(sessions);
      if (requestId === sessionListRequestId) set({ sessions, loading: false });
    } catch (err: unknown) {
      if (requestId === sessionListRequestId) {
        set({ error: err instanceof Error ? err.message : '加载会话列表失败', loading: false });
      }
    }
  },

  async createSession(input = {}) {
    try {
      const session = await sessionsApi.create(input);
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

  async setCwd(id, cwd) {
    try {
      const saved = await sessionsApi.patch(id, { cwd });
      set((state) => {
        const current = state.sessions.byId.get(id);
        if (!current) return {};
        return {
          sessions: replaceSession(state.sessions, id, {
            ...current,
            cwd: saved.cwd,
          }),
          error: null,
        };
      });
    } catch (err: unknown) {
      try {
        const saved = await sessionsApi.get(id);
        set((state) => {
          const current = state.sessions.byId.get(id);
          if (!current) return {};
          return {
            sessions: replaceSession(state.sessions, id, {
              ...current,
              cwd: saved.cwd,
            }),
          };
        });
      } catch {
        // 断线期间不猜测服务端是否保存成功；原显示值保持不动。
      }
      set({ error: err instanceof Error ? err.message : '设置执行目录失败' });
      throw err;
    }
  },

  async moveSessionInSidebar(id, input) {
    try {
      await sidebarApi.moveSession(id, input);
      await get().loadSessions();
    } catch (err: unknown) {
      await get().loadSessions();
      set({ error: err instanceof Error ? err.message : '移动对话失败' });
      throw err;
    }
  },

  async moveProjectInSidebar(id, input) {
    try {
      await sidebarApi.moveProject(id, input);
      await get().loadSessions();
    } catch (err: unknown) {
      await get().loadSessions();
      set({ error: err instanceof Error ? err.message : '移动项目失败' });
      throw err;
    }
  },

  setSessionMode(id, sessionMode) {
    return writeSessionPreference(id, 'sessionMode', sessionMode);
  },

  setNarrativePolicy(id, narrativePolicy) {
    return writeSessionPreference(id, 'narrativePolicy', narrativePolicy);
  },

  setPermissionMode(id, permissionMode) {
    return writeSessionPreference(id, 'permissionMode', permissionMode);
  },

  setTtsEnabled(id, ttsEnabled) {
    return writeSessionPreference(id, 'ttsEnabled', ttsEnabled);
  },

  setModel(id, providerId, modelId, reasoningEffort) {
    return writeModelSettings(id, {
      providerId,
      modelId,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
  },

  setReasoningEffort(id, reasoningEffort) {
    return writeModelSettings(id, { reasoningEffort });
  },

  waitForModelSettings(id) {
    return modelSettingsWriteChains.get(id) ?? Promise.resolve();
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
      modelSettingsWriteChains.delete(id);
      sessionPreferencesWriteChains.delete(id);
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '删除会话失败' });
      throw err;
    }
  },
}));

type SessionPreferenceField = 'sessionMode' | 'narrativePolicy' | 'permissionMode' | 'ttsEnabled';

/** 一个选择只保存自己的字段; 后一个选择等前一个落库后再判断是否需要写入. */
function writeSessionPreference<K extends SessionPreferenceField>(
  id: string,
  field: K,
  value: SessionListItem[K],
): Promise<void> {
  if (!useSessionStore.getState().sessions.byId.has(id)) {
    return Promise.reject(new Error(`Session not loaded: ${id}`));
  }

  const previousWrite = sessionPreferencesWriteChains.get(id) ?? Promise.resolve();
  let currentWrite!: Promise<void>;
  currentWrite = previousWrite.catch(() => {}).then(async () => {
    const current = useSessionStore.getState().sessions.byId.get(id);
    if (!current) throw new Error(`Session not loaded: ${id}`);
    if (current[field] === value) return;

    try {
      const updated = await sessionsApi.patch(id, { [field]: value });
      useSessionStore.setState((state) => {
        const session = state.sessions.byId.get(id);
        if (!session) return {};
        return {
          sessions: replaceSession(state.sessions, id, {
            ...session,
            [field]: updated[field],
          }),
          error: null,
        };
      });
    } catch (error) {
      let failure = error;
      try {
        const saved = await sessionsApi.get(id);
        useSessionStore.setState((state) => {
          const session = state.sessions.byId.get(id);
          if (!session) return {};
          return {
            sessions: replaceSession(state.sessions, id, {
              ...session,
              [field]: saved[field],
            }),
          };
        });
      } catch {
        failure = new Error('保存结果未确认, 连接恢复后请重新打开会话核对设置');
      }
      useSessionStore.setState({
        error: failure instanceof Error ? failure.message : '保存会话设置失败',
      });
      throw failure;
    }
  }).finally(() => {
    if (sessionPreferencesWriteChains.get(id) === currentWrite) {
      sessionPreferencesWriteChains.delete(id);
    }
  });
  sessionPreferencesWriteChains.set(id, currentWrite);
  return currentWrite;
}

/** 同一 Session 的模型与强度写入排队, 后一个选择只在前一个保存完后才提交. */
function writeModelSettings(
  id: string,
  patch: Pick<SessionPatchInput, 'providerId' | 'modelId' | 'reasoningEffort'>,
): Promise<void> {
  if (!useSessionStore.getState().sessions.byId.has(id)) {
    return Promise.reject(new Error(`Session not loaded: ${id}`));
  }
  const previous = modelSettingsWriteChains.get(id) ?? Promise.resolve();
  let current!: Promise<void>;
  current = previous.catch(() => {}).then(async () => {
    const saved = await sessionsApi.patch(id, patch);
    // 较早发出的侧栏读取可能仍在路上; 它不能把刚保存的模型写回旧值.
    sessionListRequestId += 1;
    useSessionStore.setState((state) => {
      const session = state.sessions.byId.get(id);
      if (!session) return {};
      return {
        sessions: replaceSession(state.sessions, id, {
          ...session,
          providerId: saved.providerId,
          modelId: saved.modelId,
          reasoningEffort: saved.reasoningEffort,
        }),
        loading: false,
        error: null,
      };
    });
  }).catch((error: unknown) => {
    useSessionStore.setState({
      error: error instanceof Error ? error.message : '保存模型设置失败',
    });
    throw error;
  }).finally(() => {
    if (modelSettingsWriteChains.get(id) === current) modelSettingsWriteChains.delete(id);
  });
  modelSettingsWriteChains.set(id, current);
  return current;
}
