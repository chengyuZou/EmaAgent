import { create } from 'zustand';
import { tauriBridge } from '../lib/tauri-bridge.js';

/**
 * Session 右侧工作区允许打开的真实 Panel 标签.
 * 固定入口复用固定 ID; 文件, 终端, 浏览器和后台进程使用资源 ID, 因此同一资源只打开一个标签.
 */
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
  // TODO: 最好是有个子代理总览跟某一个子代理
  | { id: 'subagents'; kind: 'subagents'; subagentId?: string }
  | { id: 'sources'; kind: 'sources' }
  | { id: 'tasks'; kind: 'tasks' }
  | { id: 'processes'; kind: 'processes' }
  | { id: `process:${string}`; kind: 'process'; backgroundProcessId: string };

export interface SessionSidePanelLayout {
  /** 当前 Session 已打开的标签内容, tabOrder 和 activeTabId 只保存这里存在的 ID. */
  tabsById: Record<string, SessionSidePanelTab>;
  /** 标签栏显示顺序. 再次打开已有标签只激活它, 不会把它移到末尾. */
  tabOrder: string[];
  /** 当前展示的标签; 关闭活动标签时选择它原位置附近仍存在的标签. */
  activeTabId?: string;
  /** 只控制侧栏是否可见, 关闭侧栏不会丢掉已经打开的标签. */
  open: boolean;
}

/** 统一斜杠, 重复分隔符和 Windows 盘符大小写, 为文件标签生成稳定 key. */
export function normalizeFileTabKey(filePath: string): string {
  const unified = filePath
    .replaceAll('\\', '/')
    .replaceAll(/\/{2,}/g, '/')
    .replace(/\/+$/, '');

  return /^[a-z]:\//.test(unified)
    ? unified[0]!.toUpperCase() + unified.slice(1)
    : unified;
}

/** 为工作区文件建立稳定标签 ID, 原始 path 仍交给 FilesPanel 读取. */
export function fileTab(filePath: string): SessionSidePanelTab {
  return {
    id: `file:${normalizeFileTabKey(filePath)}`,
    kind: 'file',
    path: filePath,
  };
}

/** Session 附件和来源文件使用独立 kind, 避免与工作区同路径文件混用面板行为. */
export function sessionSourceTab(sourcePath: string): SessionSidePanelTab {
  return {
    id: `source:${normalizeFileTabKey(sourcePath)}`,
    kind: 'source',
    path: sourcePath,
  };
}

/** 一个 Terminal ID 对应一个可重复激活的终端标签. */
export function terminalTab(terminalId: string): SessionSidePanelTab {
  return { id: `terminal:${terminalId}`, kind: 'terminal', terminalId };
}

/** Summary 中点击某个后台进程时打开该进程自己的输出标签, 不是进程列表标签. */
export function backgroundProcessTab(backgroundProcessId: string): SessionSidePanelTab {
  return {
    id: `process:${backgroundProcessId}`,
    kind: 'process',
    backgroundProcessId,
  };
}

/** 浏览器创建时 URL 尚未回报, BrowserPanel 后续按 browserId 更新同一个标签. */
export function browserTab(browserId: string): SessionSidePanelTab {
  return { id: `browser:${browserId}`, kind: 'browser', browserId, url: null };
}

const DEFAULT_RIGHT_PANEL_PERCENT = 30;
const MIN_RIGHT_PANEL_PERCENT = 20;
const MAX_RIGHT_PANEL_PERCENT = 70;

function emptySidePanelLayout(): SessionSidePanelLayout {
  return { tabsById: {}, tabOrder: [], open: false };
}

function removeSidePanelTab(
  layout: SessionSidePanelLayout,
  tabId: string,
): SessionSidePanelLayout {
  const index = layout.tabOrder.indexOf(tabId);
  if (index < 0) return layout;
  const tabOrder = layout.tabOrder.filter(id => id !== tabId);
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

interface SessionPanelStore {
  /** 每个 Session 独立保存标签和开关状态, 切换 Session 不会覆盖另一个 Session 的侧栏. */
  readonly layouts: Record<string, SessionSidePanelLayout>;
  /** Chat 主内容与右侧 Panel 的全局宽度比例, 在不同 Session 之间保持一致. */
  readonly rightPanelPercent: number;
  /** 新标签追加到末尾; 已存在的标签更新内容并直接激活. */
  openTab(sessionId: string, tab: SessionSidePanelTab): void;
  /** 关闭标签并选择相邻标签; Browser 标签同时关闭对应 Tauri Browser. */
  closeTab(sessionId: string, tabId: string): void;
  /** 用户点击标签时激活它并重新展开侧栏, 不创建不存在的标签. */
  activateTab(sessionId: string, tabId: string): void;
  /** Header 的侧栏按钮只改变可见性, 保留当前标签和活动位置. */
  setSidePanelOpen(sessionId: string, open: boolean): void;
  /** 拖动分隔线时保存宽度, 并限制在 20% 到 70% 之间. */
  setRightPanelPercent(percent: number): void;
  /** Tauri Browser 导航或标题变化后更新对应 browserId 标签. */
  updateBrowserTab(
    sessionId: string,
    browserId: string,
    patch: { url?: string; title?: string },
  ): void;
  /** Session 关闭, 归档或删除时先关闭它的 Browser, 再删除整个侧栏布局. */
  removeSessionLayout(sessionId: string): void;
}

/** Session 页面, Header 与各 Panel 共享的右侧工作区 Store. */
export const useSessionPanelStore = create<SessionPanelStore>((set, get) => ({
  layouts: {},
  rightPanelPercent: DEFAULT_RIGHT_PANEL_PERCENT,

  // 标签按资源 ID 去重. 再次打开同一文件, 终端或进程只激活原标签.
  openTab(sessionId, tab) {
    set(state => {
      const layout = state.layouts[sessionId] ?? emptySidePanelLayout();
      return {
        layouts: {
          ...state.layouts,
          [sessionId]: {
            tabsById: { ...layout.tabsById, [tab.id]: tab },
            tabOrder: layout.tabOrder.includes(tab.id)
              ? layout.tabOrder
              : [...layout.tabOrder, tab.id],
            activeTabId: tab.id,
            open: true,
          },
        },
      };
    });
  },

  closeTab(sessionId, tabId) {
    const tab = get().layouts[sessionId]?.tabsById[tabId];
    if (tab?.kind === 'browser') void tauriBridge.closeBrowser(tab.browserId).catch(() => {});
    set(state => {
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

  // 标签激活与侧栏开关只改变布局, 不创建或销毁资源.
  activateTab(sessionId, tabId) {
    set(state => {
      const layout = state.layouts[sessionId];
      if (!layout?.tabOrder.includes(tabId)) return state;
      return {
        layouts: {
          ...state.layouts,
          [sessionId]: { ...layout, activeTabId: tabId, open: true },
        },
      };
    });
  },

  setSidePanelOpen(sessionId, open) {
    set(state => {
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

  // Browser URL 和标题由 Tauri Browser 回报, 只能更新同 browserId 的既有标签.
  updateBrowserTab(sessionId, browserId, patch) {
    set(state => {
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
            tabsById: { ...layout.tabsById, [tabId]: nextTab },
          },
        },
      };
    });
  },

  // 删除 Session 布局前先关闭它创建的 Browser; 文件, 终端和进程由各自业务管理生命周期.
  removeSessionLayout(sessionId) {
    const layout = get().layouts[sessionId];
    for (const tab of Object.values(layout?.tabsById ?? {})) {
      if (tab.kind === 'browser') void tauriBridge.closeBrowser(tab.browserId).catch(() => {});
    }
    set(state => {
      const layouts = { ...state.layouts };
      delete layouts[sessionId];
      return { layouts };
    });
  },
}));
