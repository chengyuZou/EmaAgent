/**
 * 运行时工具协议定义。
 */

import type { ToolResult } from "@ema-agent/core-types";

/** 工具执行上下文 */
export interface ToolExecutionContext {
  sessionId: string;
  requestId: string;
  traceId: string;
  args: Record<string, unknown>;
}

/** 运行时工具协议 */
export interface RuntimeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;

  /** 是否可与其他只读工具并发执行 */
  isConcurrencySafe(): boolean;

  /** 风险级别判定 */
  riskLevel(args: Record<string, unknown>): "low" | "medium" | "high";

  /** 执行工具 */
  execute(ctx: ToolExecutionContext): Promise<ToolResult>;
}
