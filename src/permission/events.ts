// 定义权限等待与决策结果进入统一事件流时使用的稳定协议。
import type { PermissionRequest } from './types.js';

export type PermissionRequiredEvent = PermissionRequest & { readonly type: 'permission_required' };

export type PermissionResolvedEvent = {
  readonly type: 'permission_resolved';
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly decision: 'allow' | 'deny';
} & (
    | { readonly subagentId?: never; readonly runId?: never }
    | { readonly subagentId: string; readonly runId: string }
  );

export type PermissionStreamEvent =
  | PermissionRequiredEvent
  | PermissionResolvedEvent;
