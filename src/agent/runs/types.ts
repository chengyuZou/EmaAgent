import type { AgentRunId, SessionId, TaskId, TurnId } from '@ema-agent/ids';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRunKind = 'subagent' | 'fork';
export type AgentRunTranscriptRole =
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'coordinator';

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

export interface AgentRunTranscriptAppend {
  agentRunId: AgentRunId;
  role: AgentRunTranscriptRole;
  content: unknown;
  createdAt: number;
}

export interface AgentRunTranscriptMessage extends AgentRunTranscriptAppend {
  id: string;
  sequence: number;
}

/** AgentRun 执行链只获得追加能力，不能借此查询或修改既有记录。 */
export interface AgentRunTranscriptWriter {
  insert(message: AgentRunTranscriptAppend): void;
}

/** HTTP、CLI 等查询入口只读取领域消息，不接触 SQLite 行或 JSON 列。 */
export interface AgentRunTranscriptReader {
  listForRun(agentRunId: AgentRunId): readonly AgentRunTranscriptMessage[];
}
