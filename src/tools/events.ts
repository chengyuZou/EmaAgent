// 定义工具调用、原始结果与用户询问产生的业务事件。
import type { TaskEvent } from '@ema-agent/tasks';

export interface ToolError {
  code: string;
  message: string;
}

export interface AskUserQuestionSpec {
  /** 回答键（q0/q1…）；模型看到的最终答案以问题文本为键，Tool 负责映射。 */
  id: string;
  question: string;
  header: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type ToolStreamEvent =
  | { type: 'tool_call_partial'; sessionId: string; blockIndex: number; callId: string; name: string; argsDelta: string }
  | { type: 'tool_call_complete'; sessionId: string; blockIndex: number; callId: string; name: string; args: unknown }
  | {
      type: 'tool_progress';
      sessionId: string;
      turnId: string;
      callId: string;
      name: string;
      /** 不同 Tool 的进度形状由自己的 TProgress 定义，SSE 只负责透明传输。 */
      progress: unknown;
    }
  | { type: 'tool_result'; sessionId: string; callId: string; name: string; output?: unknown; error?: ToolError; durationMs: number }
  | {
      type: 'ask_user_required';
      sessionId: string;
      turnId: string;
      /** 问询锚点 = 发起它的那次 Tool 调用；一个交互只可能属于一次 toolCall，不再另设 promptId。 */
      toolCallId: string;
      questions: AskUserQuestionSpec[];
      humanDescription?: string;
    }
  | {
      type: 'ask_user_resolved';
      sessionId: string;
      toolCallId: string;
      answers: Record<string, string>;
    };

/** 工具执行上下文允许业务工具向外发出的领域事件。 */
export type ToolExecutionEvent = ToolStreamEvent | TaskEvent;

export type AskUserRequiredEvent = Extract<ToolStreamEvent, { type: 'ask_user_required' }>;

export interface PendingAskUserPrompt {
  createdAt: number;
  request: AskUserRequiredEvent;
}
