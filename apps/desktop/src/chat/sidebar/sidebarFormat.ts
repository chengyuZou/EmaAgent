// 侧栏展示用的文本与时间格式化辅助，以及侧栏共享的 API 推导类型。
import type { SessionsGrouped } from '../../api/sessions.js';

/** 侧栏会话行：分组列表的 SessionListItem 投影（含 lastTurnStatus/hasUnread）。 */
export type SidebarSession = SessionsGrouped['recent'][number];
/** 服务端五桶分组的项目槽（project + folders + 成员 Session）。 */
export type SidebarProjectGroup = SessionsGrouped['projects'][number];

export function basename(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function formatRelativeTime(updatedAt: number): string {
  const diff = Math.max(0, Date.now() - updatedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)}小时前`;
  if (diff < week) return `${Math.floor(diff / day)}天前`;
  if (diff < month) return `${Math.floor(diff / week)}周前`;
  return `${Math.floor(diff / month)}月前`;
}

export function projectLabelFor(session: SidebarSession): string {
  return session.workspaceRoot ? basename(session.workspaceRoot) : '对话';
}
