import { create } from 'zustand';
import type { SettingsTabId } from '../settings/SettingsPanel.js';

export enum MainView {
  Chat = 'chat',
  Settings = 'settings',
}

type MainLocation =
  | { readonly view: MainView.Chat; readonly sessionId: string | null }
  | { readonly view: MainView.Settings; readonly settingsTab: SettingsTabId };

export interface TurnNavigationRequest {
  readonly sessionId: string;
  readonly turnId: string;
}

interface MainNavigationState {
  readonly activeView: MainView;
  // 只控制非 settings 侧栏, Settings 导航始终展开.
  readonly sidebarOpen: boolean;
  readonly viewedSessionId: string | null;
  /** 点击定位时保存目标, 不随正在播放的 Turn 自动改变. */
  readonly turnNavigationRequest: TurnNavigationRequest | null;
  // 新对话共享同一份项目和目录选择, 查看已有会话时也保留它们.
  readonly newSessionProjectId: string | null;
  // null 表示使用项目主文件夹或 Ema 默认工作目录.
  readonly newSessionCwd: string | null;
  readonly settingsTab: SettingsTabId;
  readonly history: readonly MainLocation[];
  readonly historyIndex: number;
  setActiveView(view: MainView): void;
  setSettingsTab(tab: SettingsTabId): void;
  toggleSidebar(): void;
  goBack(): void;
  goForward(): void;
  viewSession(sessionId: string): void;
  viewTurn(sessionId: string, turnId: string): void;
  finishTurnNavigation(request: NonNullable<MainNavigationState['turnNavigationRequest']>): void;
  openNewSession(projectId?: string): void;
  setNewSessionCwd(cwd: string): void;
  promoteNewSession(sessionId: string): void;
  evictSession(sessionId: string): void;
}

const HISTORY_LIMIT = 20;

function sameLocation(left: MainLocation, right: MainLocation): boolean {
  if (left.view === MainView.Chat && right.view === MainView.Chat) {
    return left.sessionId === right.sessionId;
  }
  if (left.view === MainView.Settings && right.view === MainView.Settings) {
    return left.settingsTab === right.settingsTab;
  }
  return false;
}

function appendHistory(
  state: MainNavigationState,
  location: MainLocation,
): Pick<MainNavigationState, 'history' | 'historyIndex'> {
  if (sameLocation(state.history[state.historyIndex]!, location)) {
    return { history: state.history, historyIndex: state.historyIndex };
  }
  const history = [...state.history.slice(0, state.historyIndex + 1), location];
  if (history.length > HISTORY_LIMIT) {
    history.shift();
  }
  return { history, historyIndex: history.length - 1 };
}

function selectLocation(location: MainLocation): Partial<Pick<
  MainNavigationState,
  'activeView' | 'viewedSessionId' | 'settingsTab'
>> {
  if (location.view === MainView.Chat) {
    return {
      activeView: MainView.Chat,
      viewedSessionId: location.sessionId,
    };
  }
  return { activeView: MainView.Settings, settingsTab: location.settingsTab };
}

export const useMainNavigationStore = create<MainNavigationState>((set, get) => ({
  activeView: MainView.Chat,
  sidebarOpen: true,
  viewedSessionId: null,
  turnNavigationRequest: null,
  newSessionProjectId: null,
  newSessionCwd: null,
  settingsTab: 'providers',
  history: [{ view: MainView.Chat, sessionId: null }],
  historyIndex: 0,

  setActiveView(view) {
    set(state => {
      let location: MainLocation;
      if (view === MainView.Chat) {
        location = { view, sessionId: state.viewedSessionId };
      } else {
        location = { view, settingsTab: state.settingsTab };
      }
      return { ...selectLocation(location), ...appendHistory(state, location), turnNavigationRequest: null };
    });
  },

  setSettingsTab(settingsTab) {
    set(state => {
      const location: MainLocation = { view: MainView.Settings, settingsTab };
      return { ...selectLocation(location), ...appendHistory(state, location), turnNavigationRequest: null };
    });
  },

  toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),

  goBack() {
    const state = get();
    if (state.historyIndex === 0) {
      return;
    }
    const historyIndex = state.historyIndex - 1;
    set({ ...selectLocation(state.history[historyIndex]!), historyIndex, turnNavigationRequest: null });
  },

  goForward() {
    const state = get();
    if (state.historyIndex === state.history.length - 1) {
      return;
    }
    const historyIndex = state.historyIndex + 1;
    set({ ...selectLocation(state.history[historyIndex]!), historyIndex, turnNavigationRequest: null });
  },

  viewSession(sessionId) {
    set(state => {
      const location: MainLocation = { view: MainView.Chat, sessionId };
      return { ...selectLocation(location), ...appendHistory(state, location), turnNavigationRequest: null };
    });
  },

  viewTurn(sessionId, turnId) {
    set(state => {
      const location: MainLocation = { view: MainView.Chat, sessionId };
      return {
        ...selectLocation(location),
        ...appendHistory(state, location),
        turnNavigationRequest: { sessionId, turnId },
      };
    });
  },

  finishTurnNavigation(request) {
    if (get().turnNavigationRequest === request) {
      set({ turnNavigationRequest: null });
    }
  },

  openNewSession(projectId) {
    set(state => {
      const location: MainLocation = { view: MainView.Chat, sessionId: null };
      return {
        ...selectLocation(location),
        ...appendHistory(state, location),
        newSessionProjectId: projectId ?? null,
        newSessionCwd: null,
        turnNavigationRequest: null,
      };
    });
  },

  setNewSessionCwd(cwd) {
    set({ newSessionCwd: cwd });
  },

  promoteNewSession(sessionId) {
    set(state => ({
      // 新对话创建不是一次新的访问. 用户已切到其他位置时不抢回当前 View.
      history: state.history.map(location => {
        if (location.view === MainView.Chat && location.sessionId === null) {
          return { view: MainView.Chat, sessionId };
        }
        return location;
      }),
      viewedSessionId: state.viewedSessionId ?? sessionId,
      newSessionProjectId: null,
      newSessionCwd: null,
    }));
  },

  evictSession(sessionId) {
    set(state => {
      const isRemoved = (location: MainLocation): boolean => (
        location.view === MainView.Chat && location.sessionId === sessionId
      );
      const history: MainLocation[] = [];
      let historyIndex = 0;
      for (let index = 0; index < state.history.length; index += 1) {
        let location = state.history[index]!;
        if (isRemoved(location)) {
          if (index !== state.historyIndex) {
            continue;
          }
          location = { view: MainView.Chat, sessionId: null };
        }
        const previous = history[history.length - 1];
        if (!previous || !sameLocation(previous, location)) {
          history.push(location);
        }
        if (index <= state.historyIndex) {
          historyIndex = history.length - 1;
        }
      }
      const viewedRemoved = state.viewedSessionId === sessionId;
      return {
        history,
        historyIndex,
        viewedSessionId: viewedRemoved ? null : state.viewedSessionId,
        turnNavigationRequest: state.turnNavigationRequest?.sessionId === sessionId ? null : state.turnNavigationRequest,
      };
    });
  },
}));

