// 侧栏"项目"分组的纯函数推导:显式分组优先,剩余按工作区目录聚合。
import type { SessionWire } from '../../api/sessions.js';
import type { SessionsState } from '../../stores/session-store.js';
import { basename } from './sidebarFormat.js';

export interface ProjectGroup {
  label: string;
  sessions: SessionWire[];
}

export function buildProjectGroups(sessions: SessionsState): ProjectGroup[] {
  const out: ProjectGroup[] = [];
  const used = new Set<string>();

  for (const g of sessions.byGroup) {
    const groupSessions = uniqueSessions(g.sessions);
    if (groupSessions.length === 0) continue;
    for (const s of groupSessions) used.add(s.id);
    out.push({ label: g.label, sessions: groupSessions });
  }

  const workspaceGroups = new Map<string, SessionWire[]>();
  for (const s of uniqueSessions([...sessions.pinned, ...sessions.recent])) {
    if (used.has(s.id)) continue;
    const root = s.workspaceRoot;
    if (!root) continue;
    const label = basename(root);
    const list = workspaceGroups.get(label) ?? [];
    list.push(s);
    workspaceGroups.set(label, list);
    used.add(s.id);
  }

  for (const [label, groupSessions] of workspaceGroups.entries()) {
    out.push({ label, sessions: uniqueSessions(groupSessions) });
  }

  return out;
}

export function uniqueSessions(items: SessionWire[]): SessionWire[] {
  const seen = new Set<string>();
  const out: SessionWire[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
