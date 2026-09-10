import type { AssistantBlock } from '@ema-agent/llm';
import type { SubagentContextMode, ToolResult } from '@ema-agent/tools';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRunMessageRole = 'assistant' | 'tool_result';

export interface AgentRun {
  readonly id: string;
  readonly sessionId: string;
  readonly parentTurnId: string;
  readonly parentAgentRunId?: string;
  readonly contextMode: SubagentContextMode;
  readonly description?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: AgentRunStatus;
  readonly error?: string;
  readonly iterations?: number;
  readonly toolCallCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly finalText?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface AgentRunStart {
  agentRunId: string;
  sessionId: string;
  parentTurnId: string;
  parentAgentRunId?: string;
  contextMode: SubagentContextMode;
  description?: string;
  providerId?: string;
  modelId?: string;
}

export interface AgentRunCompletion {
  iterations: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  finalText: string;
}

export type AgentRunTransitionAction = 'complete' | 'fail' | 'cancel';

export type AgentRunTransitionResult =
  | { ok: true; changed: boolean; run: AgentRun }
  | {
      ok: false;
      reason: 'not_found' | 'conflict';
      action: AgentRunTransitionAction;
      current?: AgentRun;
    };

/**
 * 子 Agent 转录按完整模型消息保存. AssistantBlock 自带原始块顺序和 tool_use,
 * tool_result 则沿用统一 ToolResult 信封, 因而不需要另造块级身份.
 */
export type AgentRunMessage =
  | {
      readonly id: string;
      readonly agentRunId: string;
      readonly role: 'assistant';
      readonly content: readonly AssistantBlock[];
      readonly sequence: number;
      readonly createdAt: number;
    }
  | {
      readonly id: string;
      readonly agentRunId: string;
      readonly role: 'tool_result';
      readonly content: ToolResult;
      readonly sequence: number;
      readonly createdAt: number;
    };

/** 启动恢复从 AgentRun 转录找回的原始调用与已有结果. */
export interface AgentRunToolInteraction {
  readonly name: string;
  readonly args: unknown;
  result?: ToolResult;
}
