import type {
  LlmGenerationSource,
  LlmCallStatus,
  LlmStopReason,
  LlmThinkingState,
  LlmTokenUsage,
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
      /** 协议原生推理状态（signature/id/thoughtSignature）；缺失 = 无续接状态。 */
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
    }
  | {
      /** AgentLoop 已把这些消息追加进下一次调用会读取的工作历史。 */
      readonly type: 'model_history_appended';
      readonly llmCallId: string;
      readonly messages: readonly Message[];
    }
  | {
      /** 本次 Assistant 已流式落库，但恢复策略决定从头重试，不得进入后续模型历史。 */
      readonly type: 'assistant_message_discarded';
      readonly reason: 'max_tokens_retry';
    }
  | { readonly type: 'tool_result'; readonly result: ToolResult }
  | { readonly type: 'phase_changed'; readonly state: AgentLoopState }
  | {
      readonly type: 'loop_stopped';
      readonly finalText: string;
      readonly state: AgentLoopState;
    };

export type AgentRunEvent =
  | {
      readonly type: 'agent_run_started';
      readonly agentRunId: string;
      readonly contextMode: SubagentContextMode;
      readonly modelId?: string;
      readonly description?: string;
      readonly startedAt: number;
    }
  | {
      readonly type: 'agent_run_event';
      readonly agentRunId: string;
      readonly event: AgentLoopEvent;
    }
  | {
      readonly type: 'agent_run_completed';
      readonly agentRunId: string;
      readonly finalText: string;
      readonly state: AgentLoopState;
      readonly durationMs: number;
    }
  | {
      readonly type: 'agent_run_failed';
      readonly agentRunId: string;
      readonly error: string;
      readonly durationMs: number;
    }
  | {
      readonly type: 'agent_run_aborted';
      readonly agentRunId: string;
      readonly reason: string;
      readonly durationMs: number;
    };
