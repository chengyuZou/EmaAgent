// Chat 工作区标签与布局的可判别类型；持久化只用可 JSON 序列化结构，禁止 meta 猜内容。

export type WorkspaceDockId = 'right' | 'bottom';

export type WorkspaceTab =
  | { id: 'review'; kind: 'review' }
  | { id: 'files'; kind: 'files' }
  | { id: `file:${string}`; kind: 'file'; path: string }
  | { id: `terminal:${string}`; kind: 'terminal'; terminalId: string }
  | { id: `browser:${string}`; kind: 'browser'; browserId: string }
  | { id: `agentRun:${string}`; kind: 'agentRun'; agentRunId: string }
  | { id: 'sources'; kind: 'sources' };

/**
 * 每个 Session 一份的标签布局。
 * 注意：RightDock 宽度与 BottomDock 高度是全局桌面偏好（计划 §4.4），
 * 由 workspaceStore 的全局字段持有，不进每 Session 布局。
 */
export interface WorkspaceLayoutState {
  tabsById: Record<string, WorkspaceTab>;
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

export function fileTab(path: string): WorkspaceTab {
  return { id: `file:${normalizeFileTabKey(path)}`, kind: 'file', path };
}

export function agentRunTab(agentRunId: string): WorkspaceTab {
  return { id: `agentRun:${agentRunId}`, kind: 'agentRun', agentRunId };
}
