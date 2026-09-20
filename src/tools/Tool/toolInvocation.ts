/**
 * ToolInvocation 在准备阶段后创建，并贯穿校验、权限和执行。
 * Tool 属于哪个 AgentRun 由执行环境写入 tool_executions, 具体 Tool 不读取这项归属。
 */
export interface ToolInvocation {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
}
