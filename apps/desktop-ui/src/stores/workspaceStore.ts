// Chat 工作区每 Session 的标签布局状态机与前端本地持久化。
import { create } from 'zustand';
import type { SessionId } from '@ema-agent/ids';
import type {
  WorkspaceDockId,
  WorkspaceLayoutState,
  WorkspaceTab,
} from './workspaceTypes.js';

// ── 常量与持久化 ─────────────────────────────────────────────────────────────

export const DEFAULT_RIGHT_WIDTH = 320;
export const DEFAULT_BOTTOM_HEIGHT = 240;
export const MIN_RIGHT_WIDTH = 240;
export const MIN_BOTTOM_HEIGHT = 160;

const STORAGE_KEY = 'ema-workspace-layout-v1';

interface PersistedWorkspace {
  layouts: Record<string, WorkspaceLayoutState>;
  rightWidth: number;
  bottomHeight: number;
}

function readStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function loadPersisted(): PersistedWorkspace {
  const fallback: PersistedWorkspace = {
    layouts: {},
    rightWidth: DEFAULT_RIGHT_WIDTH,
    bottomHeight: DEFAULT_BOTTOM_HEIGHT,
  };
  const storage = readStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspace>;
    return {
      layouts: sanitizeLayouts(parsed.layouts),
      rightWidth: typeof parsed.rightWidth === 'number' && parsed.rightWidth >= MIN_RIGHT_WIDTH
        ? parsed.rightWidth : DEFAULT_RIGHT_WIDTH,
      bottomHeight: typeof parsed.bottomHeight === 'number' && parsed.bottomHeight >= MIN_BOTTOM_HEIGHT
        ? parsed.bottomHeight : DEFAULT_BOTTOM_HEIGHT,
    };
  } catch {
    // 损坏的持久层不阻断启动，按默认布局继续。
    return fallback;
  }
}

/** 逐条校验持久化布局，丢弃结构损坏的 Session 条目。 */
function sanitizeLayouts(input: unknown): Record<string, WorkspaceLayoutState> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, WorkspaceLayoutState> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const v = value as Partial<WorkspaceLayoutState>;
    if (!Array.isArray(v.rightTabOrder) || !Array.isArray(v.bottomTabOrder)) continue;
    if (v.tabsById === null || typeof v.tabsById !== 'object') continue;
    const tabsById = v.tabsById as Record<string, WorkspaceTab>;
    const rightTabOrder = v.rightTabOrder.filter((id): id is string => typeof id === 'string' && id in tabsById);
    const bottomTabOrder = v.bottomTabOrder.filter((id): id is string => typeof id === 'string' && id in tabsById);
    out[key] = {
      tabsById,
      rightTabOrder,
      bottomTabOrder,
      ...(typeof v.activeRightTabId === 'string' && rightTabOrder.includes(v.activeRightTabId)
        ? { activeRightTabId: v.activeRightTabId } : {}),
      ...(typeof v.activeBottomTabId === 'string' && bottomTabOrder.includes(v.activeBottomTabId)
        ? { activeBottomTabId: v.activeBottomTabId } : {}),
      rightOpen: v.rightOpen === true && rightTabOrder.length > 0,
      bottomOpen: v.bottomOpen === true && bottomTabOrder.length > 0,
    };
  }
  return out;
}

// ── 布局纯函数（全部返回新对象，不原地修改） ────────────────────────────────

function emptyLayout(): WorkspaceLayoutState {
  return { tabsById: {}, rightTabOrder: [], bottomTabOrder: [], rightOpen: false, bottomOpen: false };
}

function dockOf(layout: WorkspaceLayoutState, tabId: string): WorkspaceDockId | undefined {
  if (layout.rightTabOrder.includes(tabId)) return 'right';
  if (layout.bottomTabOrder.includes(tabId)) return 'bottom';
  return undefined;
}

function orderOf(layout: WorkspaceLayoutState, dock: WorkspaceDockId): string[] {
  return dock === 'right' ? layout.rightTabOrder : layout.bottomTabOrder;
}

function insertTab(
  layout: WorkspaceLayoutState,
  tab: WorkspaceTab,
  dock: WorkspaceDockId,
): WorkspaceLayoutState {
  const order = [...orderOf(layout, dock), tab.id];
  return dock === 'right'
    ? { ...layout, tabsById: { ...layout.tabsById, [tab.id]: tab }, rightTabOrder: order }
    : { ...layout, tabsById: { ...layout.tabsById, [tab.id]: tab }, bottomTabOrder: order };
}

function activateInLayout(
  layout: WorkspaceLayoutState,
  tabId: string,
  dock: WorkspaceDockId,
): WorkspaceLayoutState {
  return dock === 'right'
    ? { ...layout, activeRightTabId: tabId, rightOpen: true }
    : { ...layout, activeBottomTabId: tabId, bottomOpen: true };
}

function moveTabInLayout(
  layout: WorkspaceLayoutState,
  tabId: string,
  to: WorkspaceDockId,
): WorkspaceLayoutState {
  const from = dockOf(layout, tabId);
  if (!from || from === to) return layout;
  const fromOrder = orderOf(layout, from).filter((id) => id !== tabId);
  const toOrder = [...orderOf(layout, to), tabId];
  // 源 Dock 失去最后一个标签时自动折叠；目标 Dock 的激活由调用方处理。
  const base: WorkspaceLayoutState = from === 'right'
    ? {
        ...layout,
        rightTabOrder: fromOrder,
        bottomTabOrder: toOrder,
        activeRightTabId: layout.activeRightTabId === tabId ? undefined : layout.activeRightTabId,
        rightOpen: fromOrder.length > 0 ? layout.rightOpen : false,
      }
    : {
        ...layout,
        bottomTabOrder: fromOrder,
        rightTabOrder: toOrder,
        activeBottomTabId: layout.activeBottomTabId === tabId ? undefined : layout.activeBottomTabId,
        bottomOpen: fromOrder.length > 0 ? layout.bottomOpen : false,
      };
  return base;
}

function removeTabFromLayout(
  layout: WorkspaceLayoutState,
  tabId: string,
): WorkspaceLayoutState {
  const dock = dockOf(layout, tabId);
  if (!dock) return layout;
  const order = orderOf(layout, dock);
  const removedIndex = order.indexOf(tabId);
  const nextOrder = order.filter((id) => id !== tabId);
  const tabsById = { ...layout.tabsById };
  delete tabsById[tabId];
  // 激活项被关闭时让位给同位置邻居（末尾则前移一位）。
  const activeId = dock === 'right' ? layout.activeRightTabId : layout.activeBottomTabId;
  const nextActive = activeId === tabId
    ? nextOrder[Math.min(removedIndex, nextOrder.length - 1)]
    : activeId;
  const base = { ...layout, tabsById };
  return dock === 'right'
    ? {
        ...base,
        rightTabOrder: nextOrder,
        ...(nextActive !== undefined ? { activeRightTabId: nextActive } : {}),
        rightOpen: nextOrder.length > 0 ? layout.rightOpen : false,
      }
    : {
        ...base,
        bottomTabOrder: nextOrder,
        ...(nextActive !== undefined ? { activeBottomTabId: nextActive } : {}),
        bottomOpen: nextOrder.length > 0 ? layout.bottomOpen : false,
      };
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface WorkspaceState {
  layouts: Record<string, WorkspaceLayoutState>;
  /** 全局桌面偏好：RightDock 宽度与 BottomDock 高度（§4.4，不随 Session 切换）。 */
  rightWidth: number;
  bottomHeight: number;
  /**
   * RightDock 全宽展开（§3.5）：当次运行状态，不进持久化。
   * 折叠 Dock 时丢弃；消费方仍需按 rightOpen && 有标签派生有效性。
   */
  fullWidthBySession: Record<string, boolean>;

  /**
   * 打开或激活标签。同一资源全局只存在一个实例：
   * 已存在于目标 Dock → 仅激活；已存在于另一个 Dock 且显式指定 dock → 移动同一实例；
   * 未指定 dock → 留在原 Dock 激活，新标签默认进右侧。
   */
  openTab(sessionId: SessionId, tab: WorkspaceTab, opts?: { dock?: WorkspaceDockId }): void;
  /** 显式关闭；关闭后不再复活，关闭最后标签时该 Dock 自动折叠。 */
  closeTab(sessionId: SessionId, tabId: string): void;
  activateTab(sessionId: SessionId, tabId: string): void;
  /** 右 ⇄ 底移动，保持同一标签实例与内部状态。 */
  moveTab(sessionId: SessionId, tabId: string, to: WorkspaceDockId): void;
  /** 折叠只隐藏 Dock，标签保留，下次打开原样恢复。 */
  setDockOpen(sessionId: SessionId, dock: WorkspaceDockId, open: boolean): void;
  setRightWidth(width: number): void;
  setBottomHeight(height: number): void;
  /** 进入/退出 RightDock 全宽展开；false 也用于折叠后清理。 */
  setFullWidth(sessionId: SessionId, fullWidth: boolean): void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  ...loadPersisted(),
  fullWidthBySession: {},

  openTab(sessionId, tab, opts) {
    set((state) => {
      const key = sessionId as string;
      const layout = state.layouts[key] ?? emptyLayout();
      const currentDock = dockOf(layout, tab.id);
      const targetDock = opts?.dock ?? currentDock ?? 'right';
      let next = layout;
      if (currentDock && currentDock !== targetDock) {
        next = moveTabInLayout(next, tab.id, targetDock);
      } else if (!currentDock) {
        next = insertTab(next, tab, targetDock);
      }
      next = activateInLayout(next, tab.id, targetDock);
      return { layouts: { ...state.layouts, [key]: next } };
    });
  },

  closeTab(sessionId, tabId) {
    set((state) => {
      const key = sessionId as string;
      const layout = state.layouts[key];
      if (!layout || !dockOf(layout, tabId)) return state;
      return { layouts: { ...state.layouts, [key]: removeTabFromLayout(layout, tabId) } };
    });
  },

  activateTab(sessionId, tabId) {
    set((state) => {
      const key = sessionId as string;
      const layout = state.layouts[key];
      if (!layout) return state;
      const dock = dockOf(layout, tabId);
      if (!dock) return state;
      return { layouts: { ...state.layouts, [key]: activateInLayout(layout, tabId, dock) } };
    });
  },

  moveTab(sessionId, tabId, to) {
    set((state) => {
      const key = sessionId as string;
      const layout = state.layouts[key];
      if (!layout) return state;
      const next = activateInLayout(moveTabInLayout(layout, tabId, to), tabId, to);
      return { layouts: { ...state.layouts, [key]: next } };
    });
  },

  setDockOpen(sessionId, dock, open) {
    set((state) => {
      const key = sessionId as string;
      const layout = state.layouts[key] ?? emptyLayout();
      const next = dock === 'right'
        ? { ...layout, rightOpen: open }
        : { ...layout, bottomOpen: open };
      // 折叠 RightDock 丢弃全宽标记（§3.5：下次打开回到普通宽度）。
      const fullWidthBySession = dock === 'right' && !open && state.fullWidthBySession[key]
        ? { ...state.fullWidthBySession, [key]: false }
        : state.fullWidthBySession;
      return { layouts: { ...state.layouts, [key]: next }, fullWidthBySession };
    });
  },

  setRightWidth(width) {
    set({ rightWidth: Math.max(MIN_RIGHT_WIDTH, Math.round(width)) });
  },

  setBottomHeight(height) {
    set({ bottomHeight: Math.max(MIN_BOTTOM_HEIGHT, Math.round(height)) });
  },

  setFullWidth(sessionId, fullWidth) {
    set((state) => ({
      fullWidthBySession: { ...state.fullWidthBySession, [sessionId as string]: fullWidth },
    }));
  },
}));

// 每次变更直接落盘：布局操作是低频用户动作，无需节流。
useWorkspaceStore.subscribe((state) => {
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      layouts: state.layouts,
      rightWidth: state.rightWidth,
      bottomHeight: state.bottomHeight,
    } satisfies PersistedWorkspace));
  } catch {
    // 持久化失败（隐私模式/配额）不阻断布局操作。
  }
});

/** 派生有效全宽：标记 + RightDock 展开 + 有标签三者同时成立（§3.5）。 */
export function isRightFullWidth(
  state: Pick<WorkspaceState, 'layouts' | 'fullWidthBySession'>,
  sessionId: SessionId | null,
): boolean {
  if (!sessionId) return false;
  const layout = state.layouts[sessionId as string];
  return state.fullWidthBySession[sessionId as string] === true
    && layout?.rightOpen === true
    && layout.rightTabOrder.length > 0;
}
