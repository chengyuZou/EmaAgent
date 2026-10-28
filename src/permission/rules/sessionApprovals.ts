import type { PermissionRuleKey } from '../types.js';

// 只记住本进程内各 Session 的批准. 普通 Turn 完成不清除, Session 删除或进程退出后失效.
const sessionApprovals = new Map<string, PermissionRuleKey[]>();

export function getSessionApprovals(sessionId: string): readonly PermissionRuleKey[] {
  return sessionApprovals.get(sessionId) ?? [];
}

export function rememberSessionApproval(sessionId: string, key: PermissionRuleKey): void {
  const approvals = sessionApprovals.get(sessionId) ?? [];
  if (approvals.some(saved => saved.toolName === key.toolName && saved.condition === key.condition)) return;
  sessionApprovals.set(sessionId, [...approvals, { ...key }]);
}

export function clearSessionApprovals(sessionId: string): void {
  sessionApprovals.delete(sessionId);
}
