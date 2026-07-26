// 定义工具调用、结果展示与用户询问产生的业务事件。
import type { SessionId, TurnId } from '@ema-agent/ids';
import type { TaskEvent } from '@ema-agent/tasks';
import type { ToolPresentation } from './presentation/index.js';

export interface ToolError {
  code: string;
  message: string;
}

/** 工具失败发生在执行流水线的哪个边界。 */
export type ToolFailurePhase =
  | 'policy'
  | 'permission'
  | 'validation'
  | 'persistence'
  | 'execution';

export interface AskUserQuestionSpec {
  id: string;
  question: string;
  header: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  allowCustom?: boolean;
  placeholder?: string;
}

export type ToolStreamEvent =
  | { type: 'tool_call_partial'; sessionId: SessionId; blockIndex: number; callId: string; name: string; argsDelta: string }
  | { type: 'tool_call_complete'; sessionId: SessionId; blockIndex: number; callId: string; name: string; args: unknown }
  | { type: 'tool_result'; sessionId: SessionId; callId: string; name: string; output?: unknown; presentation?: ToolPresentation; error?: ToolError; durationMs: number }
  | {
      type: 'ask_user_required';
      sessionId: SessionId;
      turnId: TurnId;
      promptId: string;
      questions: AskUserQuestionSpec[];
      humanDescription?: string;
    }
  | {
      type: 'ask_user_resolved';
      sessionId: SessionId;
      promptId: string;
      answers: Record<string, string>;
    }
  | { type: 'ask_confirm_required'; sessionId: SessionId; turnId: TurnId; promptId: string; question: string; humanDescription?: string }
  | { type: 'ask_confirm_resolved'; sessionId: SessionId; promptId: string; confirmed: boolean }
  | { type: 'ask_text_required'; sessionId: SessionId; turnId: TurnId; promptId: string; question: string; humanDescription?: string; placeholder?: string }
  | { type: 'ask_text_resolved'; sessionId: SessionId; promptId: string; text: string }
  | {
      type: 'ask_choice_required';
      sessionId: SessionId;
      turnId: TurnId;
      promptId: string;
      question: string;
      humanDescription?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
      allowCustom?: boolean;
    }
  | { type: 'ask_choice_resolved'; sessionId: SessionId; promptId: string; selected: string[]; customText?: string };

/** 工具执行上下文允许业务工具向外发出的领域事件。 */
export type ToolExecutionEvent = ToolStreamEvent | TaskEvent;

export type AskUserRequiredEvent = Extract<
  ToolStreamEvent,
  {
    type:
      | 'ask_user_required'
      | 'ask_confirm_required'
      | 'ask_text_required'
      | 'ask_choice_required';
  }
>;

export interface PendingAskUserPrompt {
  createdAt: number;
  request: AskUserRequiredEvent;
}
