import type { SubagentContextMode } from '@ema-agent/tools';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRunMessageRole =
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning';

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
  readonly outputExcerpt?: string;
  readonly version: number;
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
  outputExcerpt?: string;
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

export interface AgentRunMessage {
  readonly id: string;
  readonly agentRunId: string;
  readonly role: AgentRunMessageRole;
  readonly content: unknown;
  readonly sequence: number;
  readonly createdAt: number;
}
