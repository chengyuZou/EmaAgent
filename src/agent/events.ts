// 定义 AgentLoop 内部事件与 AgentRun 对外执行事件。
import type { AgentRunId, SessionId, TaskId, TurnId } from '@ema-agent/ids';
import type { LlmCallId, LlmTokenUsage } from '@ema-agent/llm';
import type {
  ToolError,
  ToolExecutionEvent,
  ToolExecutionResult,
} from '@ema-agent/tools';
import type { SubagentContextMode } from '@ema-agent/tool-builtin';
import type { TurnEvent, TurnStats } from '@ema-agent/turn';
import type { PermissionStreamEvent } from '@ema-agent/permission';
import type { AgentLoopState } from './agentLoopState.js';

export type AgentKind = SubagentContextMode;

export type AgentLoopEvent<TExecutorEvent> =
  | {
      type: 'loop_iteration';
      n: number;
      state: AgentLoopState;
      /** 本次模型调用是否继续上一段被输出上限截断的回答。 */
      continuesOutput: boolean;
    }
  | { type: 'loop_text_delta'; delta: string; blockIndex: number }
  | { type: 'loop_thinking_delta'; delta: string; blockIndex: number }
  | { type: 'loop_thinking_complete'; blockIndex: number; signature?: string }
  | { type: 'loop_tool_partial'; callId: string; name: string; argsDelta: string; blockIndex: number }
  | { type: 'loop_tool_complete'; callId: string; name: string; args: unknown; blockIndex: number }
  | {
      type: 'loop_request_degraded';
      attempt: number;
      reason: string;
      removed: Array<'image' | 'audio' | 'file' | 'parameter'>;
      replacements: Array<'description' | 'placeholder' | 'parameter_omitted'>;
    }
  | { type: 'loop_relay'; ev: TExecutorEvent }
  | { type: 'loop_usage'; usage: LlmTokenUsage }
  | {
      type: 'loop_llm_complete';
      iteration: number;
      llmCallId: LlmCallId;
      usage: LlmTokenUsage;
      promptPrefixHash: string | null;
    }
  | { type: 'loop_tool_results'; results: ToolExecutionResult[]; fullText: string }
  | { type: 'loop_breaker'; reason: string };

export type SubagentInnerEvent =
  | { type: 'iteration'; sessionId: SessionId; subagentId: AgentRunId; taskId?: TaskId; n: number; elapsedMs: number }
  | { type: 'text_delta'; sessionId: SessionId; subagentId: AgentRunId; taskId?: TaskId; delta: string }
  | { type: 'reasoning_delta'; sessionId: SessionId; subagentId: AgentRunId; taskId?: TaskId; delta: string }
  | { type: 'tool_call'; sessionId: SessionId; subagentId: AgentRunId; taskId?: TaskId; callId: string; name: string; args: unknown; iteration: number }
  | { type: 'tool_result'; sessionId: SessionId; subagentId: AgentRunId; taskId?: TaskId; callId: string; name: string; excerpt: string; bytes: number; isError: boolean; error?: ToolError; durationMs: number };

export type AgentRunEvent =
  | {
      type: 'subagent_started';
      sessionId: SessionId;
      subagentId: AgentRunId;
      parentTurnId: TurnId;
      description?: string;
      model: string;
      kind: AgentKind;
      promptExcerpt: string;
      startedAtMs: number;
    }
  | { type: 'subagent_progress'; sessionId: SessionId; subagentId: AgentRunId; iteration: number; elapsedMs: number; toolCallCount: number }
  | { type: 'subagent_completed'; sessionId: SessionId; subagentId: AgentRunId; outputExcerpt: string; iterationCount: number; toolCallCount: number; stats: TurnStats }
  | { type: 'subagent_failed'; sessionId: SessionId; subagentId: AgentRunId; error: string; atIteration: number; elapsedMs: number }
  | { type: 'subagent_aborted'; sessionId: SessionId; subagentId: AgentRunId; reason: string; elapsedMs: number }
  | { type: 'subagent_stream'; sessionId: SessionId; subagentId: AgentRunId; ev: SubagentInnerEvent };

export type AgentTurnEvent =
  | { type: 'agent_iteration'; sessionId: SessionId; turnId: TurnId; n: number }
  | { type: 'agent_breaker_tripped'; sessionId: SessionId; turnId: TurnId; reason: string };

/** 子 Agent 调度器可向父 Turn 转发的事件，不包含根 Turn 终态和角色表现。 */
export type AgentExecutionEvent =
  | AgentRunEvent
  | ToolExecutionEvent
  | PermissionStreamEvent
  | Extract<
      TurnEvent,
      { type: 'request_degraded' | 'turn_projection_warning' }
    >;

/** 从 Agent 执行通道中识别真正属于 AgentRun 生命周期的事件。 */
export function isAgentRunEvent(
  event: AgentExecutionEvent,
): event is AgentRunEvent {
  switch (event.type) {
    case 'subagent_started':
    case 'subagent_progress':
    case 'subagent_completed':
    case 'subagent_failed':
    case 'subagent_aborted':
    case 'subagent_stream':
      return true;
    default:
      return false;
  }
}
