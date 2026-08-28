// 侧栏展示用的路径与相对时间格式化辅助。
import type { SessionListItem } from '../../api/sessions.js';

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

export function projectLabelFor(session: SessionListItem): string {
  return session.workspaceRoot ? basename(session.workspaceRoot) : '对话';
}
