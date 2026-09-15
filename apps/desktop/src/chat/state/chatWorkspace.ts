// 持有 Chat 当前页面、未发送草稿, 以及每个 Session 的右侧面板布局.
import { create } from 'zustand';
import { sessionsApi } from '../../api/sessions.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
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
      url: string | null;
      title?: string;
    }
  | { id: 'subagents'; kind: 'subagents' }
  | { id: 'sources'; kind: 'sources' }
  | { id: 'tasks'; kind: 'tasks' }
  | { id: 'processes'; kind: 'processes' }
  | { id: `process:${string}`; kind: 'process'; backgroundProcessId: string };

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

export function backgroundProcessTab(backgroundProcessId: string): SessionSidePanelTab {
  return {
    id: `process:${backgroundProcessId}`,
    kind: 'process',
    backgroundProcessId,
  };
}

export function browserTab(
  browserId: string,
): SessionSidePanelTab {
  return {
    id: `browser:${browserId}`,
    kind: 'browser',
    browserId,
    url: null,
  };
}

const DEFAULT_RIGHT_PANEL_PERCENT = 30;
const MIN_RIGHT_PANEL_PERCENT = 20;
const MAX_RIGHT_PANEL_PERCENT = 70;

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

interface SessionSidePanelState {
  layouts: Record<string, SessionSidePanelLayout>;
  rightPanelPercent: number;
  openTab(sessionId: string, tab: SessionSidePanelTab): void;
  closeTab(sessionId: string, tabId: string): void;
  activateTab(sessionId: string, tabId: string): void;
  setSidePanelOpen(sessionId: string, open: boolean): void;
  setRightPanelPercent(percent: number): void;
  updateBrowserTab(
    sessionId: string,
    browserId: string,
    patch: { url?: string; title?: string },
  ): void;
  removeSessionLayout(sessionId: string): void;
}

export const useSessionSidePanel = create<SessionSidePanelState>((set, get) => ({
  layouts: {},
  rightPanelPercent: DEFAULT_RIGHT_PANEL_PERCENT,

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
    const tab = get().layouts[sessionId]?.tabsById[tabId];
    if (tab?.kind === 'browser') {
      void tauriBridge.closeBrowser(tab.browserId).catch(() => {});
    }
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

  setSidePanelOpen(sessionId, open) {
    set((state) => {
      const layout = state.layouts[sessionId] ?? emptySidePanelLayout();
      return {
        layouts: {
          ...state.layouts,
          [sessionId]: { ...layout, open },
        },
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
    const layout = get().layouts[sessionId];
    for (const tab of Object.values(layout?.tabsById ?? {})) {
      if (tab.kind === 'browser') {
        void tauriBridge.closeBrowser(tab.browserId).catch(() => {});
      }
    }
    set((state) => {
      const layouts = { ...state.layouts };
      delete layouts[sessionId];

      return { layouts };
    });
  },
}));
