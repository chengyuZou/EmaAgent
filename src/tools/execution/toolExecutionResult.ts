// 定义工具运行时返回给 Agent 循环的结果，不混入 Session 持久化消息所有权。
import type { ToolPresentation } from '../presentation/index.js';

export interface ToolExecutionResult {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
  durationMs?: number;
  errorCode?: string;
  presentation?: ToolPresentation;
}
