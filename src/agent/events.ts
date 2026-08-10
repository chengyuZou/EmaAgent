import type { AgentRunId } from '@ema-agent/ids';
import type { LlmStopReason, LlmTokenUsage } from '@ema-agent/llm';
import type { ToolResult } from '@ema-agent/tools';
import type { AgentLoopState } from './agentLoopState.js';
import type { AgentRunKind } from './runs/types.js';

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
      readonly signature?: string;
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
  | { readonly type: 'usage_updated'; readonly usage: LlmTokenUsage }
  | {
      readonly type: 'assistant_message_completed';
      readonly iteration: number;
      readonly usage: LlmTokenUsage;
      readonly stopReason: LlmStopReason;
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
      readonly agentRunId: AgentRunId;
      readonly kind: AgentRunKind;
      readonly modelId?: string;
      readonly description?: string;
      readonly startedAt: number;
    }
  | {
      readonly type: 'agent_run_event';
      readonly agentRunId: AgentRunId;
      readonly event: AgentLoopEvent;
    }
  | {
      readonly type: 'agent_run_completed';
      readonly agentRunId: AgentRunId;
      readonly finalText: string;
      readonly state: AgentLoopState;
      readonly durationMs: number;
    }
  | {
      readonly type: 'agent_run_failed';
      readonly agentRunId: AgentRunId;
      readonly error: string;
      readonly durationMs: number;
    }
  | {
      readonly type: 'agent_run_aborted';
      readonly agentRunId: AgentRunId;
      readonly reason: string;
      readonly durationMs: number;
    };
