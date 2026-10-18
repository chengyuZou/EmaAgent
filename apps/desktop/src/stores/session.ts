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
import type { ReasoningEffort } from '@ema-agent/session';
import type { PermissionMode } from '@ema-agent/permission';

const SESSION_TITLE_DISPLAY_LENGTH = 10;
const SESSION_TITLE_ELLIPSIS = '...';
const titleSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function formatSessionTitle(title: string): string {
  let visible = '';
  let length = 0;
  for (const part of titleSegmenter.segment(title)) {
    if (length === SESSION_TITLE_DISPLAY_LENGTH) {
      return visible + SESSION_TITLE_ELLIPSIS;
    }
    visible += part.segment;
    length += 1;
  }
  return visible;
}


export interface SessionsState {
  pinned:   SessionListItem[];
  pinnedProjects: Project[];
  projects: Project[];
  recent:   SessionListItem[];
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
  setPermissionMode(id: string, permissionMode: PermissionMode): Promise<void>;
  setTTSEnabled(id: string, ttsEnabled: boolean): Promise<void>;
  /** 模型身份成对保存; 不支持推理的模型在同一请求里把强度设为 off. */
  setModel(id: string, providerId: string, modelId: string, reasoningEffort?: ReasoningEffort): Promise<void>;
  setReasoningEffort(id: string, reasoningEffort: ReasoningEffort): Promise<void>;
  waitForModelSettings(id: string): Promise<void>;
  forkSession(id: string, untilTurnId?: string):                   Promise<string>;
  archiveSession(id: string):                                    Promise<void>;
  unarchiveSession(id: string):                                   Promise<void>;
  deleteSession(id: string):                                     Promise<void>;
}


function emptySessions(): SessionsState {
  return { pinned: [], pinnedProjects: [], projects: [], recent: [], byId: new Map() };
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
    byId: new Map(sessions.byId),
  };
  next.byId.set(id, replacement);
  return next;
}

function withoutSessions(sessions: SessionsState, sessionIds: ReadonlySet<string>): SessionsState {
  const keep = (session: SessionListItem): boolean => !sessionIds.has(session.id);
  const removeFromProject = (project: Project): Project => ({
    ...project,
    sessions: project.sessions.filter(keep),
  });
  const byId = new Map(sessions.byId);
  for (const sessionId of sessionIds) {
    byId.delete(sessionId);
  }
  return {
    pinned: sessions.pinned.filter(keep),
    pinnedProjects: sessions.pinnedProjects.map(removeFromProject),
    projects: sessions.projects.map(removeFromProject),
    recent: sessions.recent.filter(keep),
    byId,
  };
}

// 同一 Session 的设置写入按点击顺序落库, 发送前的权限保存也要排在先前选择之后.
const modelSettingsWriteChains = new Map<string, Promise<void>>();
const sessionPreferencesWriteChains = new Map<string, Promise<void>>();
let sessionListRequestId = 0;
let deletedDuringSessionListRead: Set<string> | null = null;


export const useSessionStore = create<SessionStoreState>((set, get) => ({
  sessions:     emptySessions(),
  loading:      false,
  error:        null,

  async loadSessions() {
    const requestId = ++sessionListRequestId;
    const deletedSessionIds = new Set<string>();
    deletedDuringSessionListRead = deletedSessionIds;
    set({ loading: true, error: null });
    try {
      const sidebarData = await sessionsApi.listForSidebar();
      let sessions: SessionsState = {
        pinned:   [...sidebarData.pinned],
        pinnedProjects: [...sidebarData.pinnedProjects],
        projects: [...sidebarData.projects],
        recent:   [...sidebarData.recent],
        byId:     new Map(),
      };
      rebuildById(sessions);
      // 批量删除通知可能先于本次列表响应到达, 保留其他行但排除已经被删除的 ID.
      if (deletedSessionIds.size > 0) {
        sessions = withoutSessions(sessions, deletedSessionIds);
      }
      if (requestId === sessionListRequestId) set({ sessions, loading: false });
    } catch (err: unknown) {
      if (requestId === sessionListRequestId) {
        set({ error: err instanceof Error ? err.message : '加载会话列表失败', loading: false });
      }
    } finally {
      if (deletedDuringSessionListRead === deletedSessionIds) {
        deletedDuringSessionListRead = null;
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
        // 断线期间不猜测服务端是否保存成功; 原显示值保持不动.
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


  setPermissionMode(id, permissionMode) {
    return writeSessionPreference(id, 'permissionMode', permissionMode);
  },

  setTTSEnabled(id, ttsEnabled) {
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
      // 已收到归档成功结果, 后续列表刷新失败也不能再显示这条会话.
      sessionListRequestId += 1;
      set(state => ({ sessions: withoutSessions(state.sessions, new Set([id])), loading: false }));
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
      sessionListRequestId += 1;
      set(state => ({ sessions: withoutSessions(state.sessions, new Set([id])), loading: false }));
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : '删除会话失败' });
      throw err;
    }
  },
}));

/** 后端已提交批量删除; 直接移除这些会话的本地状态, 不逐条重新请求侧栏. */
export function forgetDeletedSessions(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) {
    deletedDuringSessionListRead?.add(sessionId);
    modelSettingsWriteChains.delete(sessionId);
    sessionPreferencesWriteChains.delete(sessionId);
  }
  const current = useSessionStore.getState().sessions;
  if (!sessionIds.some(sessionId => current.byId.has(sessionId))) {
    return;
  }
  useSessionStore.setState(state => ({
    sessions: withoutSessions(state.sessions, new Set(sessionIds)),
  }));
}

type SessionPreferenceField = 'permissionMode' | 'ttsEnabled';

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
