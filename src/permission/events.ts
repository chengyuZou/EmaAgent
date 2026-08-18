// 定义权限等待与决策结果进入统一事件流时使用的稳定协议。
import type { PermissionRequest } from './types.js';

export interface PermissionRequiredEvent extends PermissionRequest {
  readonly type: 'permission_required';
}

export interface PermissionResolvedEvent {
  readonly type: 'permission_resolved';
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly decision: 'allow' | 'deny';
}

export type PermissionStreamEvent =
  | PermissionRequiredEvent
  | PermissionResolvedEvent;
