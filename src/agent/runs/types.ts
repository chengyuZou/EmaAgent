import type { AgentRunId, SessionId, TaskId, TurnId } from '@ema-agent/ids';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRunKind = 'subagent' | 'fork';

export interface AgentRun {
  id: AgentRunId;
  sessionId: SessionId;
  parentTurnId: TurnId;
  parentAgentRunId?: AgentRunId;
  taskId?: TaskId;
  kind: AgentRunKind;
  purpose?: string;
  providerConfigId?: string;
  modelId?: string;
  status: AgentRunStatus;
  error?: string;
  iterations?: number;
  toolCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  outputExcerpt?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
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

export interface AgentRunStorePort {
  start(input: AgentRunStart): AgentRun;
  complete(
    agentRunId: AgentRunId,
    completion: AgentRunCompletion,
  ): AgentRunTransitionResult;
  fail(agentRunId: AgentRunId, reason: string): AgentRunTransitionResult;
  cancel(agentRunId: AgentRunId, reason: string): AgentRunTransitionResult;
}
