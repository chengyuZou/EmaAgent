// 读取、清理 AgentRun 快照与子智能体执行记录。
import { sidecarClient } from './sidecar-client.js';

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRunKind = 'subagent' | 'fork';

export interface AgentRunWire {
  id: string;
  sessionId: string;
  parentTurnId: string;
  parentAgentRunId?: string;
  taskId?: string;
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

export type AgentRunMessageRole = 'assistant' | 'tool_call' | 'tool_result' | 'reasoning';

export interface AssistantMessageContent { text: string }
export interface ReasoningMessageContent { text: string }
export interface ToolCallMessageContent {
  callId: string;
  name: string;
  args: unknown;
  iteration: number;
}
export interface ToolResultMessageContent {
  callId: string;
  name: string;
  excerpt: string;
  isError: boolean;
  error?: string;
  durationMs: number;
}

export interface AgentRunMessageWire {
  id: string;
  agentRunId: string;
  role: AgentRunMessageRole;
  content:
    | AssistantMessageContent
    | ReasoningMessageContent
    | ToolCallMessageContent
    | ToolResultMessageContent;
  createdAt: number;
}

export const agentRunsApi = {
  list(
    sessionId: string,
    status?: AgentRunStatus,
  ): Promise<{ runs: AgentRunWire[] }> {
    const params = new URLSearchParams({ sessionId });
    if (status) params.set('status', status);
    return sidecarClient.request(`/api/agent-runs?${params}`);
  },

  get(agentRunId: string): Promise<{ run: AgentRunWire }> {
    return sidecarClient.request(`/api/agent-runs/${agentRunId}`);
  },

  delete(agentRunId: string): Promise<{ ok: boolean }> {
    return sidecarClient.request(`/api/agent-runs/${agentRunId}`, { method: 'DELETE' });
  },

  clear(sessionId: string): Promise<{ deleted: number }> {
    return sidecarClient.request('/api/agent-runs/clear', {
      method: 'POST',
      json: { sessionId },
    });
  },

  listMessages(agentRunId: string): Promise<{ messages: AgentRunMessageWire[] }> {
    return sidecarClient.request(`/api/agent-runs/${agentRunId}/messages`);
  },
};
