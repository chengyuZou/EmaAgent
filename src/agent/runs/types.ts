import type { AgentRunId, SessionId, TaskId, TurnId } from '@ema-agent/ids';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRunKind = 'subagent' | 'fork';
export type AgentRunTranscriptRole =
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning';

export interface AgentRun {
  readonly id: AgentRunId;
  readonly sessionId: SessionId;
  readonly parentTurnId: TurnId;
  readonly parentAgentRunId?: AgentRunId;
  readonly taskId?: TaskId;
  readonly kind: AgentRunKind;
  readonly purpose?: string;
  readonly providerConfigId?: string;
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
  agentRunId: AgentRunId;
  sessionId: SessionId;
  parentTurnId: TurnId;
  parentAgentRunId?: AgentRunId;
  taskId?: TaskId;
  kind: AgentRunKind;
  purpose?: string;
  providerConfigId?: string;
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

export interface AgentRunTranscriptMessage {
  readonly id: string;
  readonly agentRunId: AgentRunId;
  readonly role: AgentRunTranscriptRole;
  readonly content: unknown;
  readonly sequence: number;
  readonly createdAt: number;
}
