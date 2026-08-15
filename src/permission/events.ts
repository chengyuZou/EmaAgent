// 定义权限等待与决策结果进入统一事件流时使用的稳定协议。
import type { PermissionPrompt } from './types.js';

export interface PermissionRequiredEvent extends PermissionPrompt {
  readonly type: 'permission_required';
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly promptId: string;
}

export interface PermissionResolvedEvent {
  readonly type: 'permission_resolved';
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly promptId: string;
  readonly decision: 'allow' | 'deny';
}

export type PermissionStreamEvent =
  | PermissionRequiredEvent
  | PermissionResolvedEvent;
