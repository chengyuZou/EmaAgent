// 描述一次 Tool 调用的根身份、所属执行和取消信号。
import type {
  AgentRunId,
  SessionId,
  ToolCallId,
  TurnId,
} from '@ema-agent/ids';

/**
 * ToolInvocation 在准备阶段后创建，并贯穿校验、权限、执行、进度和审计。
 * 根 Agent 与子 Agent 共用父 Turn；只有子 Agent 调用额外携带 agentRunId。
 */
export interface ToolInvocation {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly agentRunId?: AgentRunId;
  readonly toolCallId: ToolCallId;
  readonly signal: AbortSignal;
}
