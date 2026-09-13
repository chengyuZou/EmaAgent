// 持有 Chat 当前页面、未发送草稿, 以及每个 Session 的右侧面板布局.
import { create } from 'zustand';
import { sessionsApi } from '../../api/sessions.js';
import { stopTtsPlayback } from '../../lib/tts-playback.js';
import { useSessionStore } from '../../stores/session.js';
import { emptyChatDraft, type ChatDraft } from '../input/InputReferences.js';

interface ChatWorkspaceState {
  readonly viewedSessionId: string | null;
  /** null 表示普通新对话, string 表示在指定 Project 中新建; undefined 表示已有 Session. */
  readonly newSessionProjectId: string | null | undefined;
  /** null 表示沿用所选项目主文件夹，或无项目时的默认执行目录。 */
  readonly newSessionCwd: string | null;
  readonly draftMap: ReadonlyMap<string, ChatDraft>;
  readonly newSessionDraft: ChatDraft;
  readonly scrollToTurnId: string | null;
  viewSession(id: string): Promise<void>;
  openNewSession(projectId?: string): void;
  setNewSessionCwd(cwd: string): void;
  promoteNewSession(id: string): void;
  setDraft(draft: ChatDraft): void;
  setDraftFor(sessionId: string | null, draft: ChatDraft): void;
  scrollToTurn(turnId: string): void;
  evictSession(id: string): void;
}

export const useChatWorkspace = create<ChatWorkspaceState>((set, get) => ({
  viewedSessionId: null,
  newSessionProjectId: null,
  newSessionCwd: null,
  draftMap: new Map(),
  newSessionDraft: emptyChatDraft(),
  scrollToTurnId: null,

  async viewSession(id) {
    const previous = get().viewedSessionId;
    if (previous && previous !== id) stopTtsPlayback(previous);

    set({ viewedSessionId: id, newSessionProjectId: undefined });
    void sessionsApi.markViewed(id)
      .then(() => useSessionStore.getState().loadSessions())
      .catch(() => {});
  },

  openNewSession(projectId) {
    // 全局入口与 Project 入口共享未发送草稿, 来回切换只改变首次创建归属.
    set({
      viewedSessionId: null,
      newSessionProjectId: projectId ?? null,
      newSessionCwd: null,
      scrollToTurnId: null,
    });
  },

  setNewSessionCwd(cwd) {
    set({ newSessionCwd: cwd });
  },

  promoteNewSession(id) {
    const draftMap = new Map(get().draftMap);
    draftMap.set(id, get().newSessionDraft);
    set({
      viewedSessionId: id,
      newSessionProjectId: undefined,
      newSessionCwd: null,
      newSessionDraft: emptyChatDraft(),
      draftMap,
    });
  },

  setDraft(draft) {
    const sessionId = get().viewedSessionId;
    if (!sessionId) {
      set({ newSessionDraft: draft });
      return;
    }
    set((state) => {
      const draftMap = new Map(state.draftMap);
      draftMap.set(sessionId, draft);
      return { draftMap };
    });
  },

  setDraftFor(sessionId, draft) {
    if (!sessionId) {
      set({ newSessionDraft: draft });
      return;
    }

    set((state) => ({
      draftMap: new Map(state.draftMap).set(sessionId, draft),
    }));
  },

  scrollToTurn(turnId) {
    set({ scrollToTurnId: turnId });
  },

  evictSession(id) {
    set((state) => {
      const draftMap = new Map(state.draftMap);
      draftMap.delete(id);
      const wasViewed = state.viewedSessionId === id;
      return {
        draftMap,
        viewedSessionId: wasViewed ? null : state.viewedSessionId,
        newSessionProjectId: wasViewed ? null : state.newSessionProjectId,
        newSessionCwd: wasViewed ? null : state.newSessionCwd,
      };
    });
  },
}));

export type SessionSidePanelTab =
  | { id: 'review'; kind: 'review' }
  | { id: 'files'; kind: 'files' }
  | { id: `file:${string}`; kind: 'file'; path: string }
  | { id: `source:${string}`; kind: 'source'; path: string }
  | { id: `terminal:${string}`; kind: 'terminal'; terminalId: string }
  | {
      id: `browser:${string}`;
      kind: 'browser';
      browserId: string;
      url: string;
      title?: string;
    }
  | { id: 'subagents'; kind: 'subagents' }
  | { id: 'sources'; kind: 'sources' }
  | { id: 'tasks'; kind: 'tasks' }
  | { id: 'processes'; kind: 'processes' };

export interface SessionSidePanelLayout {
  tabsById: Record<string, SessionSidePanelTab>;
  tabOrder: string[];
  activeTabId?: string;
  open: boolean;
}

export function normalizeFileTabKey(filePath: string): string {
  const unified = filePath
    .replaceAll('\\', '/')
    .replaceAll(/\/{2,}/g, '/')
    .replace(/\/+$/, '');

  return /^[a-z]:\//.test(unified)
    ? unified[0]!.toUpperCase() + unified.slice(1)
    : unified;
}

export function fileTab(filePath: string): SessionSidePanelTab {
  return {
    id: `file:${normalizeFileTabKey(filePath)}`,
    kind: 'file',
    path: filePath,
  };
}

export function sessionSourceTab(sourcePath: string): SessionSidePanelTab {
  return {
    id: `source:${normalizeFileTabKey(sourcePath)}`,
    kind: 'source',
    path: sourcePath,
  };
}

export function terminalTab(terminalId: string): SessionSidePanelTab {
  return {
    id: `terminal:${terminalId}`,
    kind: 'terminal',
    terminalId,
  };
}

export function browserTab(
  browserId: string,
  url: string,
): SessionSidePanelTab {
  return {
    id: `browser:${browserId}`,
    kind: 'browser',
    browserId,
    url,
  };
}

const SIDE_PANEL_STORAGE_KEY = 'ema-chat-side-panel';
const DEFAULT_RIGHT_PANEL_PERCENT = 30;
const MIN_RIGHT_PANEL_PERCENT = 20;
const MAX_RIGHT_PANEL_PERCENT = 70;

interface PersistedSidePanel {
  layouts: Record<string, SessionSidePanelLayout>;
  rightPanelPercent: number;
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function persistedSidePanelTab(value: unknown): SessionSidePanelTab | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const tab = value as Partial<SessionSidePanelTab>;
  if (typeof tab.id !== 'string' || typeof tab.kind !== 'string') return null;

  switch (tab.kind) {
    case 'files':
    case 'sources':
    case 'tasks':
    case 'subagents':
    case 'processes':
      return tab.id === tab.kind ? tab as SessionSidePanelTab : null;
    case 'file':
    case 'source':
      return typeof (tab as { path?: unknown }).path === 'string'
        ? tab as SessionSidePanelTab
        : null;
    case 'browser':
      return typeof (tab as { browserId?: unknown }).browserId === 'string'
        && typeof (tab as { url?: unknown }).url === 'string'
        ? tab as SessionSidePanelTab
        : null;
    default:
      // 终端只对当前进程有意义, 不跨应用重启恢复.
      return null;
  }
}

function sanitizeSidePanelLayouts(
  value: unknown,
): Record<string, SessionSidePanelLayout> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const layouts: Record<string, SessionSidePanelLayout> = {};
  for (const [sessionId, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }

    const raw = candidate as Partial<SessionSidePanelLayout>;
    if (
      !raw.tabsById
      || typeof raw.tabsById !== 'object'
      || !Array.isArray(raw.tabOrder)
    ) {
      continue;
    }

    const tabsById: Record<string, SessionSidePanelTab> = {};
    for (const item of Object.values(raw.tabsById)) {
      const tab = persistedSidePanelTab(item);
      if (tab) tabsById[tab.id] = tab;
    }

    const tabOrder = raw.tabOrder.filter((id): id is string => (
      typeof id === 'string' && id in tabsById
    ));
    layouts[sessionId] = {
      tabsById,
      tabOrder,
      ...(typeof raw.activeTabId === 'string' && tabOrder.includes(raw.activeTabId)
        ? { activeTabId: raw.activeTabId }
        : {}),
      open: raw.open === true && tabOrder.length > 0,
    };
  }

  return layouts;
}

function loadPersistedSidePanel(): PersistedSidePanel {
  const fallback: PersistedSidePanel = {
    layouts: {},
    rightPanelPercent: DEFAULT_RIGHT_PANEL_PERCENT,
  };
  const target = browserStorage();
  if (!target) return fallback;

  try {
    const raw = target.getItem(SIDE_PANEL_STORAGE_KEY);
    if (!raw) return fallback;

    const parsed = JSON.parse(raw) as Partial<PersistedSidePanel>;
    const rightPanelPercent = typeof parsed.rightPanelPercent === 'number'
      ? Math.min(
          MAX_RIGHT_PANEL_PERCENT,
          Math.max(MIN_RIGHT_PANEL_PERCENT, parsed.rightPanelPercent),
        )
      : DEFAULT_RIGHT_PANEL_PERCENT;

    return {
      layouts: sanitizeSidePanelLayouts(parsed.layouts),
      rightPanelPercent,
    };
  } catch {
    // localStorage 是外部持久边界. 内容损坏时只放弃布局, 不影响 Chat 启动.
    return fallback;
  }
}

function emptySidePanelLayout(): SessionSidePanelLayout {
  return {
    tabsById: {},
    tabOrder: [],
    open: false,
  };
}

function removeSidePanelTab(
  layout: SessionSidePanelLayout,
  tabId: string,
): SessionSidePanelLayout {
  const index = layout.tabOrder.indexOf(tabId);
  if (index < 0) return layout;

  const tabOrder = layout.tabOrder.filter((id) => id !== tabId);
  const tabsById = { ...layout.tabsById };
  delete tabsById[tabId];

  const activeTabId = layout.activeTabId === tabId
    ? tabOrder[Math.min(index, tabOrder.length - 1)]
    : layout.activeTabId;

  return {
    tabsById,
    tabOrder,
    ...(activeTabId ? { activeTabId } : {}),
    open: tabOrder.length > 0 && layout.open,
  };
}

interface SessionSidePanelState extends PersistedSidePanel {
  /** 全宽只属于本次界面状态, 关闭面板或重启后恢复普通 Chat 布局. */
  fullWidthBySession: Record<string, boolean>;
  openTab(sessionId: string, tab: SessionSidePanelTab): void;
  closeTab(sessionId: string, tabId: string): void;
  activateTab(sessionId: string, tabId: string): void;
  setOpen(sessionId: string, open: boolean): void;
  setRightPanelPercent(percent: number): void;
  setFullWidth(sessionId: string, fullWidth: boolean): void;
  updateBrowserTab(
    sessionId: string,
    browserId: string,
    patch: { url?: string; title?: string },
  ): void;
  removeSessionLayout(sessionId: string): void;
}

export const useSessionSidePanel = create<SessionSidePanelState>((set) => ({
  ...loadPersistedSidePanel(),
  fullWidthBySession: {},

  openTab(sessionId, tab) {
    set((state) => {
      const layout = state.layouts[sessionId] ?? emptySidePanelLayout();
      const next: SessionSidePanelLayout = {
        tabsById: { ...layout.tabsById, [tab.id]: tab },
        tabOrder: layout.tabOrder.includes(tab.id)
          ? layout.tabOrder
          : [...layout.tabOrder, tab.id],
        activeTabId: tab.id,
        open: true,
      };

      return {
        layouts: { ...state.layouts, [sessionId]: next },
      };
    });
  },

  closeTab(sessionId, tabId) {
    set((state) => {
      const layout = state.layouts[sessionId];
      if (!layout) return state;

      return {
        layouts: {
          ...state.layouts,
          [sessionId]: removeSidePanelTab(layout, tabId),
        },
      };
    });
  },

  activateTab(sessionId, tabId) {
    set((state) => {
      const layout = state.layouts[sessionId];
      if (!layout?.tabOrder.includes(tabId)) return state;

      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            ...layout,
            activeTabId: tabId,
            open: true,
          },
        },
      };
    });
  },

  setOpen(sessionId, open) {
    set((state) => {
      const layout = state.layouts[sessionId] ?? emptySidePanelLayout();
      const fullWidthBySession = !open && state.fullWidthBySession[sessionId]
        ? { ...state.fullWidthBySession, [sessionId]: false }
        : state.fullWidthBySession;

      return {
        layouts: {
          ...state.layouts,
          [sessionId]: { ...layout, open },
        },
        fullWidthBySession,
      };
    });
  },

  setRightPanelPercent(percent) {
    set({
      rightPanelPercent: Math.min(
        MAX_RIGHT_PANEL_PERCENT,
        Math.max(MIN_RIGHT_PANEL_PERCENT, percent),
      ),
    });
  },

  setFullWidth(sessionId, fullWidth) {
    set((state) => ({
      fullWidthBySession: {
        ...state.fullWidthBySession,
        [sessionId]: fullWidth,
      },
    }));
  },

  updateBrowserTab(sessionId, browserId, patch) {
    set((state) => {
      const layout = state.layouts[sessionId];
      const tabId = `browser:${browserId}`;
      const tab = layout?.tabsById[tabId];
      if (!layout || tab?.kind !== 'browser') return state;

      const nextTab: SessionSidePanelTab = {
        ...tab,
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
      };

      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            ...layout,
            tabsById: {
              ...layout.tabsById,
              [tabId]: nextTab,
            },
          },
        },
      };
    });
  },

  removeSessionLayout(sessionId) {
    set((state) => {
      const layouts = { ...state.layouts };
      const fullWidthBySession = { ...state.fullWidthBySession };
      delete layouts[sessionId];
      delete fullWidthBySession[sessionId];

      return { layouts, fullWidthBySession };
    });
  },
}));

useSessionSidePanel.subscribe((state) => {
  const target = browserStorage();
  if (!target) return;

  try {
    target.setItem(SIDE_PANEL_STORAGE_KEY, JSON.stringify({
      layouts: sanitizeSidePanelLayouts(state.layouts),
      rightPanelPercent: state.rightPanelPercent,
    } satisfies PersistedSidePanel));
  } catch {
    // 布局记忆失败不影响当前进程内的标签和宽度.
  }
});

export function isSessionSidePanelFullWidth(
  state: Pick<SessionSidePanelState, 'layouts' | 'fullWidthBySession'>,
  sessionId: string | null,
): boolean {
  if (!sessionId) return false;

  const layout = state.layouts[sessionId];
  return state.fullWidthBySession[sessionId] === true
    && layout?.open === true
    && layout.tabOrder.length > 0;
}
