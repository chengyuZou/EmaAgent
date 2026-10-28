export interface ToolError {
  code: string;
  message: string;
}

export type ToolExecutionEvent =
  | {
      type: 'tool_progress';
      sessionId: string;
      turnId: string;
      callId: string;
      name: string;
      /** 不同 Tool 的进度形状由自己的 TProgress 定义,Agent 事件通道只负责透明传输. */
      progress: unknown;
    }
  | {
      type: 'tool_result';
      sessionId: string;
      callId: string;
      name: string;
      output?: unknown;
      error?: ToolError;
      durationMs: number;
    };
