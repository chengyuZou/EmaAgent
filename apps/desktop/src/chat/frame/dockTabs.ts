// Chat 窗口桌面 Dock 的标签布局状态机与前端本地持久化。
// 类型与 store 同文件(禁双入口);
import { create } from 'zustand';
import type { TurnInputPart } from '@ema-agent/turn';

type DraftAttachment = Extract<TurnInputPart, { readonly type: 'attachment' }>['attachment'];

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type DockSide = 'right' | 'bottom';

export type DockTab =
  | { id: 'review'; kind: 'review' }
  | { id: 'files'; kind: 'files' }
  | { id: `file:${string}`; kind: 'file'; path: string }
  | { id: `draftAttachment:${string}`; kind: 'draftAttachment'; attachment: DraftAttachment }
  | { id: `attachment:${string}`; kind: 'attachment'; attachmentId: string }
  // 终端只保存当前进程身份；浏览器额外保存最后 URL，重启后重新创建页面。
  | { id: `terminal:${string}`; kind: 'terminal'; terminalId: string }
  | { id: `browser:${string}`; kind: 'browser'; browserId: string; url: string; title?: string }
  // 'agentRuns' 是全 Session 子智能体列表面板；'agentRun:<id>' 是单次执行的深链标签。
  | { id: 'agentRuns'; kind: 'agentRuns' }
  | { id: `agentRun:${string}`; kind: 'agentRun'; agentRunId: string }
  | { id: 'attachments'; kind: 'attachments' }
  | { id: 'tasks'; kind: 'tasks' }
  // 当前 Session 后台进程面板;列表内部导航到单次进程详情。
  | { id: 'backgroundProcesses'; kind: 'backgroundProcesses' };

/** 每个 Session 一份的标签布局。 */
export interface DockLayout {
  tabsById: Record<string, DockTab>;
  rightTabOrder: string[];
  bottomTabOrder: string[];
  activeRightTabId?: string;
  activeBottomTabId?: string;
  rightOpen: boolean;
  bottomOpen: boolean;
}

/** 资源键归一：统一斜杠、大写 Windows 盘符，避免同一路径开出两个文件标签。 */
export function normalizeFileTabKey(path: string): string {
  const unified = path.replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//.test(unified) ? unified[0]!.toUpperCase() + unified.slice(1) : unified;
}

export function fileTab(path: string): DockTab {
  return { id: `file:${normalizeFileTabKey(path)}`, kind: 'file', path };
}

export function draftAttachmentTab(attachment: DraftAttachment): DockTab {
  return {
    id: `draftAttachment:${normalizeFileTabKey(attachment.sourcePath)}`,
    kind: 'draftAttachment',
    attachment,
  };
}

export function sessionAttachmentTab(attachmentId: string): DockTab {
  return { id: `attachment:${attachmentId}`, kind: 'attachment', attachmentId };
}

export function agentRunTab(agentRunId: string): DockTab {
  return { id: `agentRun:${agentRunId}`, kind: 'agentRun', agentRunId };
}

export function terminalTab(terminalId: string): DockTab {
  return { id: `terminal:${terminalId}`, kind: 'terminal', terminalId };
}

export function browserTab(browserId: string, url: string): DockTab {
  return { id: `browser:${browserId}`, kind: 'browser', browserId, url };
}

// ── 常量与持久化 ─────────────────────────────────────────────────────────────

export const DEFAULT_RIGHT_WIDTH = 320;
export const DEFAULT_BOTTOM_HEIGHT = 240;
export const MIN_RIGHT_WIDTH = 240;
export const MIN_BOTTOM_HEIGHT = 160;

const STORAGE_KEY = 'ema-workspace-layout';

interface PersistedLayouts {
  layouts: Record<string, DockLayout>;
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

function loadPersisted(): PersistedLayouts {
  const fallback: PersistedLayouts = {
    layouts: {},
    rightWidth: DEFAULT_RIGHT_WIDTH,
    bottomHeight: DEFAULT_BOTTOM_HEIGHT,
  };
  const storage = readStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedLayouts>;
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

function persistedTab(value: unknown): DockTab | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const tab = value as Partial<DockTab>;
  if (typeof tab.id !== 'string' || typeof tab.kind !== 'string') return null;
  switch (tab.kind) {
    case 'review':
    case 'files':
    case 'attachments':
    case 'tasks':
    case 'agentRuns':
    case 'backgroundProcesses':
      return tab.id === tab.kind ? tab as DockTab : null;
    case 'file':
      return tab.id.startsWith('file:') && typeof (tab as { path?: unknown }).path === 'string'
        ? tab as DockTab : null;
    case 'attachment':
      return tab.id.startsWith('attachment:')
        && typeof (tab as { attachmentId?: unknown }).attachmentId === 'string'
        ? tab as DockTab : null;
    case 'agentRun':
      return tab.id.startsWith('agentRun:')
        && typeof (tab as { agentRunId?: unknown }).agentRunId === 'string'
        ? tab as DockTab : null;
    case 'browser':
      return tab.id.startsWith('browser:')
        && typeof (tab as { browserId?: unknown }).browserId === 'string'
        && typeof (tab as { url?: unknown }).url === 'string'
        ? tab as DockTab : null;
    default:
      // 草稿附件与终端只属于当前进程。
      return null;
  }
}

/** 只恢复具有跨重启语义的标签；旧结构和临时对象直接丢弃。 */
function sanitizeLayouts(input: unknown): Record<string, DockLayout> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, DockLayout> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const v = value as Partial<DockLayout>;
    if (!Array.isArray(v.rightTabOrder) || !Array.isArray(v.bottomTabOrder)) continue;
    if (v.tabsById === null || typeof v.tabsById !== 'object' || Array.isArray(v.tabsById)) continue;
    const tabsById: Record<string, DockTab> = {};
    for (const value of Object.values(v.tabsById)) {
      const tab = persistedTab(value);
      if (tab) tabsById[tab.id] = tab;
    }
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

function emptyLayout(): DockLayout {
  return { tabsById: {}, rightTabOrder: [], bottomTabOrder: [], rightOpen: false, bottomOpen: false };
}

function dockOf(layout: DockLayout, tabId: string): DockSide | undefined {
  if (layout.rightTabOrder.includes(tabId)) return 'right';
  if (layout.bottomTabOrder.includes(tabId)) return 'bottom';
  return undefined;
}

function orderOf(layout: DockLayout, dock: DockSide): string[] {
  return dock === 'right' ? layout.rightTabOrder : layout.bottomTabOrder;
}

function insertTab(
  layout: DockLayout,
  tab: DockTab,
  dock: DockSide,
): DockLayout {
  const order = [...orderOf(layout, dock), tab.id];
  return dock === 'right'
    ? { ...layout, tabsById: { ...layout.tabsById, [tab.id]: tab }, rightTabOrder: order }
    : { ...layout, tabsById: { ...layout.tabsById, [tab.id]: tab }, bottomTabOrder: order };
}

function activateInLayout(
  layout: DockLayout,
  tabId: string,
  dock: DockSide,
): DockLayout {
  return dock === 'right'
    ? { ...layout, activeRightTabId: tabId, rightOpen: true }
    : { ...layout, activeBottomTabId: tabId, bottomOpen: true };
}

function moveTabInLayout(
  layout: DockLayout,
  tabId: string,
  to: DockSide,
): DockLayout {
  const from = dockOf(layout, tabId);
  if (!from || from === to) return layout;
  const fromOrder = orderOf(layout, from).filter((id) => id !== tabId);
  const toOrder = [...orderOf(layout, to), tabId];
  // 源 Dock 失去最后一个标签时自动折叠；目标 Dock 的激活由调用方处理。
  const base: DockLayout = from === 'right'
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
  layout: DockLayout,
  tabId: string,
): DockLayout {
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

interface DockState {
  layouts: Record<string, DockLayout>;
  /** 全局桌面偏好：RightDock 宽度与 BottomDock 高度（不随 Session 切换）。 */
  rightWidth: number;
  bottomHeight: number;
  /**
   * RightDock 全宽展开：当次运行状态，不进持久化。
   * 折叠 Dock 时丢弃；消费方仍需按 rightOpen && 有标签派生有效性。
   */
  fullWidthBySession: Record<string, boolean>;

  /**
   * 打开或激活标签。同一资源全局只存在一个实例：
   * 已存在于目标 Dock → 仅激活；已存在于另一个 Dock 且显式指定 dock → 移动同一实例；
   * 未指定 dock → 留在原 Dock 激活，新标签默认进右侧。
   */
  openTab(sessionId: string, tab: DockTab, opts?: { dock?: DockSide }): void;
  /** 显式关闭；关闭后不再复活，关闭最后标签时该 Dock 自动折叠。 */
  closeTab(sessionId: string, tabId: string): void;
  activateTab(sessionId: string, tabId: string): void;
  /** 右 ⇄ 底移动，保持同一标签实例与内部状态。 */
  moveTab(sessionId: string, tabId: string, to: DockSide): void;
  /** 折叠只隐藏 Dock，标签保留，下次打开原样恢复。 */
  setDockOpen(sessionId: string, dock: DockSide, open: boolean): void;
  setRightWidth(width: number): void;
  setBottomHeight(height: number): void;
  /** 进入/退出 RightDock 全宽展开；false 也用于折叠后清理。 */
  setFullWidth(sessionId: string, fullWidth: boolean): void;
  /** 保存浏览器最后地址与标题，使标签和重启恢复都读取同一份事实。 */
  updateBrowserTab(sessionId: string, browserId: string, patch: { url?: string; title?: string }): void;
  /** Session 永久删除后移除其布局。 */
  removeSessionLayout(sessionId: string): void;
}

export const useDockTabs = create<DockState>((set) => ({
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
      // 折叠 RightDock 丢弃全宽标记(下次打开回到普通宽度)。
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

  updateBrowserTab(sessionId, browserId, patch) {
    set((state) => {
      const key = sessionId as string;
      const layout = state.layouts[key];
      const tabId = `browser:${browserId}`;
      const tab = layout?.tabsById[tabId];
      if (!layout || tab?.kind !== 'browser') return state;
      const nextTab: DockTab = {
        ...tab,
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
      };
      return {
        layouts: {
          ...state.layouts,
          [key]: { ...layout, tabsById: { ...layout.tabsById, [tabId]: nextTab } },
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

// 每次变更直接落盘：布局操作是低频用户动作，无需节流。
useDockTabs.subscribe((state) => {
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      layouts: sanitizeLayouts(state.layouts),
      rightWidth: state.rightWidth,
      bottomHeight: state.bottomHeight,
    } satisfies PersistedLayouts));
  } catch {
    // 持久化失败（隐私模式/配额）不阻断布局操作。
  }
});

/** 派生有效全宽：标记 + RightDock 展开 + 有标签三者同时成立。 */
export function isRightFullWidth(
  state: Pick<DockState, 'layouts' | 'fullWidthBySession'>,
  sessionId: string | null,
): boolean {
  if (!sessionId) return false;
  const layout = state.layouts[sessionId as string];
  return state.fullWidthBySession[sessionId as string] === true
    && layout?.rightOpen === true
    && layout.rightTabOrder.length > 0;
}
