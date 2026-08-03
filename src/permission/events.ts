// 定义权限等待与决策结果进入统一事件流时使用的稳定协议。
import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type { PermissionPrompt } from './types.js';

export interface PermissionRequiredEvent extends PermissionPrompt {
  readonly type: 'permission_required';
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly promptId: string;
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
