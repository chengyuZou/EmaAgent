/**
 * ToolInvocation 在准备阶段后创建，并贯穿校验、权限、执行、进度和审计。
 * 根 Agent 与子 Agent 共用父 Turn；只有子 Agent 调用额外携带 agentRunId。
 */
export interface ToolInvocation {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentRunId?: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
}
