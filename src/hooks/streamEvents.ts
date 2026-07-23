// 定义 Hook 执行失败向当前 Turn 公开的诊断事件。
import type { HookInvocationId, SessionId, TurnId } from '@ema-agent/ids';

export type HookWarningFailureKind =
  | 'handler_error'
  | 'timeout'
  | 'protocol_violation';

export interface HookWarningEvent {
  type: 'hook_warning';
  sessionId: SessionId;
  turnId: TurnId;
  hookInvocationId: HookInvocationId;
  hookEvent: string;
  handlerName: string;
  severity: 'warn' | 'error';
  failureKind: HookWarningFailureKind;
  message: string;
  timestampMs: number;
  durationMs?: number;
}
