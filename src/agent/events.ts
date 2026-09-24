import type {
  LlmGenerationSource,
  LlmCallStatus,
  LlmStopReason,
  LlmThinkingState,
  LlmTokenUsage,
  AssistantBlock,
  Message,
} from '@ema-agent/llm';
import type { ToolResult } from '@ema-agent/tools';
import type { SubagentContextMode } from '@ema-agent/tools';
import type { AgentLoopState } from './agentLoopState.js';

export type AgentLoopEvent =
  | {
      readonly type: 'iteration_started';
      readonly iteration: number;
      readonly continuesOutput: boolean;
      readonly state: AgentLoopState;
    }
  | { readonly type: 'text_delta'; readonly blockIndex: number; readonly delta: string }
  | { readonly type: 'thinking_delta'; readonly blockIndex: number; readonly delta: string }
  | {
      readonly type: 'thinking_completed';
      readonly blockIndex: number;
      /** 协议原生推理状态(signature/id/thoughtSignature)缺失 = 无续接状态 */
      readonly state?: LlmThinkingState;
    }
  | {
      readonly type: 'tool_use_partial';
      readonly blockIndex: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly argsDelta: string;
    }
  | {
      readonly type: 'tool_use_completed';
      readonly blockIndex: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly type: 'llm_call_usage_updated';
      readonly llmCallId: string;
      readonly usage: LlmTokenUsage;
    }
  | {
      readonly type: 'agent_usage_updated';
      readonly usage: LlmTokenUsage;
    }
  | {
      readonly type: 'llm_call_finished';
      readonly llmCallId: string;
      readonly source: LlmGenerationSource;
      readonly status: LlmCallStatus;
      readonly usage?: LlmTokenUsage;
      readonly startedAt: number;
      readonly durationMs: number;
      readonly errorCode?: string;
    }
  | {
      readonly type: 'assistant_message_completed';
      readonly iteration: number;
      readonly llmCallId: string;
      readonly stopReason: LlmStopReason;
      /** Provider 本轮闭合后的完整消息块. 持久化方以此为边界, 不自行拼接流式 delta. */
      readonly content: readonly AssistantBlock[];
    }
  | {
      /** AgentLoop 已把这些消息追加进下一次调用会读取的工作历史。 */
      readonly type: 'model_history_appended';
      readonly llmCallId: string;
      readonly messages: readonly Message[];
    }
  | { readonly type: 'tool_result'; readonly result: ToolResult }
  | { readonly type: 'phase_changed'; readonly state: AgentLoopState }
  | {
      readonly type: 'loop_stopped';
      readonly finalText: string;
      readonly state: AgentLoopState;
    };

export type SubagentEvent =
  | {
      readonly type: 'subagent_started';
      readonly subagentId: string;
      readonly contextMode: SubagentContextMode;
      readonly modelId?: string;
      readonly description?: string;
      readonly startedAt: number;
    }
  | {
      readonly type: 'iteration_started';
      readonly subagentId: string;
      readonly iteration: number;
      readonly continuesOutput: boolean;
    }
  | {
      readonly type: 'text_delta';
      readonly subagentId: string;
      readonly blockIndex: number;
      readonly delta: string;
    }
  | {
      readonly type: 'thinking_delta';
      readonly subagentId: string;
      readonly blockIndex: number;
      readonly delta: string;
    }
  | {
      readonly type: 'tool_use_completed';
      readonly subagentId: string;
      readonly blockIndex: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly subagentId: string;
      readonly result: ToolResult;
    }
  | {
      readonly type: 'subagent_completed';
      readonly subagentId: string;
    }
  | {
      readonly type: 'subagent_failed';
      readonly subagentId: string;
      readonly error: string;
    }
  | {
      readonly type: 'subagent_aborted';
      readonly subagentId: string;
      readonly reason: string;
    };
