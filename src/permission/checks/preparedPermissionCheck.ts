import type { PermissionDecision, PermissionRuleKey, SessionPermissionApproval } from '../types.js';

// 分类检查先计算路径, 命令等事实. 此结果仅在 Permission 包内使用, 最终决定由统一入口作出.
export interface PreparedPermissionCheck {
  readonly defaultDecision: 'allow' | 'ask';
  readonly message: string;
  // required 是必须确认的操作; alreadyApproved 表示本次电脑操控已在启动入口获准.
  readonly confirmation: 'byRules' | 'required' | 'alreadyApproved';
  readonly sessionApproval?: SessionPermissionApproval;
  // 命令的允许规则可能需要共同覆盖多条子命令, 所以一次传入同一决定下的全部条件.
  readonly matchesConditions: (conditions: readonly string[], decision: PermissionDecision) => boolean;
}

export function matchesRules(
  toolName: string,
  check: PreparedPermissionCheck,
  keys: readonly PermissionRuleKey[],
  decision: PermissionDecision,
): boolean {
  const conditions: string[] = [];
  for (const key of keys) {
    if (key.toolName !== toolName) continue;
    if (key.condition === undefined) return true;
    conditions.push(key.condition);
  }
  return check.matchesConditions(conditions, decision);
}

// 仅供明确选择完整输入批准的工具使用. 对象键顺序不影响匹配, 数组顺序和数值仍保留.
export function exactInputCondition(input: unknown): string {
  return `input:${JSON.stringify(input, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  })}`;
}
