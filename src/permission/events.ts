// 定义权限等待与决策结果进入统一事件流时使用的稳定协议。
import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type { AccessType, RiskLevel } from './types.js';

export interface PermissionRequiredEvent {
  readonly type: 'permission_required';
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly promptId: string;
  readonly toolId: string;
  readonly toolName: string;
  readonly toolDescription?: string;
  readonly input: unknown;
  readonly hint: string;
  readonly riskLevel: RiskLevel;
  readonly accessType: AccessType;
  readonly gateReason?: string;
  /** V1.5 可按需由 Tool Explainer 生成，不参与权限判定。 */
  readonly humanDescription?: string;
}

export interface PermissionResolvedEvent {
  readonly type: 'permission_resolved';
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly promptId: string;
  readonly decision: 'allow' | 'deny';
}

export type PermissionStreamEvent =
  | PermissionRequiredEvent
  | PermissionResolvedEvent;
