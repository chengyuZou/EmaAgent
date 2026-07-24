// 定义工具执行流水线可调用的生命周期观察端口，不让 Tools 反向依赖 Hook 实现。
import type { SessionId, ToolCallId, TurnId } from '@ema-agent/ids';
import type { ToolFailurePhase } from '../events.js';

export interface ToolLifecycleContext {
  sessionId: SessionId;
  turnId: TurnId;
  signal: AbortSignal;
}

export interface ToolLifecycleObserver {
  beforeToolUse(
    input: { callId: ToolCallId; name: string; args: unknown },
    context: ToolLifecycleContext,
  ): Promise<void>;
  afterToolUse(
    input: { callId: ToolCallId; name: string; output: unknown },
    context: ToolLifecycleContext,
  ): Promise<void>;
  onToolFailure(
    input: {
      callId: ToolCallId;
      name: string;
      phase: ToolFailurePhase;
      code: string;
      message: string;
      retryable: boolean;
    },
    context: ToolLifecycleContext,
  ): Promise<void>;
}
