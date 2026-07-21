// 定义权限等待与决策结果进入统一事件流时使用的稳定协议。
import type { SessionId, ToolCallId, TurnId } from '@ema-agent/contracts';
import type { AccessType, RiskLevel } from './types.js';

export interface PermissionRequiredEvent {
  type: 'permission_required';
  sessionId: SessionId;
  turnId: TurnId;
  callId: ToolCallId;
  promptId: string;
  toolId: string;
  tool: string;
  toolDescription?: string;
  args: unknown;
  hint: string;
  riskLevel: RiskLevel;
  accessType?: AccessType;
  gateReason?: string;
  /** V1.5 可按需由 Tool Explainer 生成，不参与权限判定。 */
  humanDescription?: string;
}

export interface PermissionResolvedEvent {
  type: 'permission_resolved';
  sessionId: SessionId;
  turnId: TurnId;
  callId: ToolCallId;
  promptId: string;
  decision: 'allow' | 'deny';
}

export type PermissionStreamEvent =
  | PermissionRequiredEvent
  | PermissionResolvedEvent;
