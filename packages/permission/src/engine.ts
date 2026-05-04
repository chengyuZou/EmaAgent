import type {
  PermissionDecision,
  PermissionEvaluation,
  PermissionPolicy,
  PermissionRequest,
  PermissionRisk,
  PermissionRule,
} from "./types.js"

const DECISION_PRIORITY: readonly PermissionDecision[] = ["deny", "prompt", "allow"]

const DEFAULT_DECISION_BY_RISK: Record<PermissionRisk, PermissionDecision> = {
  low: "allow",
  medium: "prompt",
  high: "prompt",
  critical: "deny",
}

/**
 * 权限引擎。
 *
 * 它只做决策，不弹 UI，也不执行工具。规则固定按 deny > prompt > allow，
 * 避免“允许规则”意外盖掉更严格的拒绝规则。
 */
export class PermissionEngine {
  constructor(private readonly policy: PermissionPolicy = { rules: [] }) {}

  evaluate(request: PermissionRequest): PermissionEvaluation {
    const matchedRule = findHighestPriorityRule(this.policy.rules, request)
    if (matchedRule) {
      return {
        decision: matchedRule.decision,
        risk: request.risk,
        reason: `命中 ${matchedRule.decision} 规则。`,
        matchedRule,
      }
    }

    const decision = this.policy.defaultDecisionByRisk?.[request.risk] ?? DEFAULT_DECISION_BY_RISK[request.risk]
    return {
      decision,
      risk: request.risk,
      reason: `按 ${request.risk} 风险默认策略处理。`,
    }
  }
}

export function createDefaultPermissionPolicy(): PermissionPolicy {
  return {
    rules: [
      {
        decision: "deny",
        risk: "critical",
      },
      {
        decision: "prompt",
        writesFiles: true,
      },
      {
        decision: "prompt",
        needsNetwork: true,
      },
    ],
    defaultDecisionByRisk: DEFAULT_DECISION_BY_RISK,
  }
}

function findHighestPriorityRule(rules: readonly PermissionRule[], request: PermissionRequest): PermissionRule | undefined {
  for (const decision of DECISION_PRIORITY) {
    const rule = rules.find((item) => item.decision === decision && matchesRule(item, request))
    if (rule) {
      return rule
    }
  }
  return undefined
}

function matchesRule(rule: PermissionRule, request: PermissionRequest): boolean {
  if (rule.toolName !== undefined && rule.toolName !== request.toolName) {
    return false
  }
  if (rule.risk !== undefined && rule.risk !== request.risk) {
    return false
  }
  if (rule.writesFiles !== undefined && rule.writesFiles !== request.writesFiles) {
    return false
  }
  if (rule.needsNetwork !== undefined && rule.needsNetwork !== request.needsNetwork) {
    return false
  }
  if (rule.pathPrefix !== undefined) {
    return (request.paths ?? []).some((path) => path.startsWith(rule.pathPrefix ?? ""))
  }
  return true
}
