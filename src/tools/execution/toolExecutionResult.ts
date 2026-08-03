// 定义工具运行时返回给 Agent 循环的结果，不混入前端展示结构。

export interface ToolExecutionResult {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
  durationMs?: number;
  errorCode?: string;
}
