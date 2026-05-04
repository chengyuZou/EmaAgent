import type { RequestId, SessionId, ToolCallId } from "@ema-agent/core-types"

export type PermissionRisk = "low" | "medium" | "high" | "critical"
export type PermissionDecision = "allow" | "prompt" | "deny"
export type PermissionGrantScope = "once" | "session" | "always"

export interface PermissionRequest {
  requestId: RequestId
  sessionId: SessionId
  toolCallId: ToolCallId
  toolName: string
  summary: string
  risk: PermissionRisk
  paths?: string[]
  writesFiles: boolean
  needsNetwork: boolean
  params?: Record<string, unknown>
}

export interface PermissionRule {
  decision: PermissionDecision
  toolName?: string
  risk?: PermissionRisk
  pathPrefix?: string
  writesFiles?: boolean
  needsNetwork?: boolean
}

export interface PermissionPolicy {
  /** 规则优先级固定为 deny > prompt > allow。 */
  rules: PermissionRule[]
  defaultDecisionByRisk?: Partial<Record<PermissionRisk, PermissionDecision>>
}

export interface PermissionEvaluation {
  decision: PermissionDecision
  risk: PermissionRisk
  reason: string
  matchedRule?: PermissionRule
}

export interface PermissionGrant {
  request: PermissionRequest
  decision: Exclude<PermissionDecision, "prompt">
  scope: PermissionGrantScope
  decidedAt: number
}
