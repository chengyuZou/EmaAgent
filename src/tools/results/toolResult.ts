// 定义工具执行后写入 Message，并在下一次模型调用中重放的唯一结果结构。

export interface ToolResult {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
  durationMs?: number;
  errorCode?: string;
}
