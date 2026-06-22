/**
 * Agent-tasks API — /api/agent-tasks
 */
import { sidecarClient } from './sidecar-client.js';

// ── Wire types (mirror backend response shapes) ───────────────────────────────

export type TaskStatus = 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';

export interface AgentTaskWire {
  id:        string;
  sessionId: string;
  turnId:    string | null;
  parentId:  string | null;
  status:    TaskStatus;
  createdAt: number;
  updatedAt: number;
  pendingPromptId?:  string;
  pendingQuestions?: unknown[];
  error?:            string;
  iterations?:       number;
  inputTokens?:      number;
  outputTokens?:     number;
}

export type TaskMessageRole = 'assistant' | 'tool_call' | 'tool_result';

export interface AssistantMessageContent  { text: string }
export interface ToolCallMessageContent   { callId: string; name: string; args: unknown; iteration: number }
export interface ToolResultMessageContent {
  callId: string; name: string; excerpt: string;
  isError: boolean; error?: string; durationMs: number;
}

export interface AgentTaskMessageWire {
  id:        string;
  taskId:    string;
  role:      TaskMessageRole;
  content:   AssistantMessageContent | ToolCallMessageContent | ToolResultMessageContent;
  createdAt: number;
}

// ── API object ────────────────────────────────────────────────────────────────

export const agentTasksApi = {
  /** GET /api/agent-tasks?sessionId=… — list tasks for session, newest first. */
  list(sessionId: string, status?: TaskStatus): Promise<{ tasks: AgentTaskWire[] }> {
    const params = new URLSearchParams({ sessionId });
    if (status) params.set('status', status);
    return sidecarClient.request(`/api/agent-tasks?${params}`);
  },

  /** GET /api/agent-tasks/:taskId */
  get(taskId: string): Promise<{ task: AgentTaskWire }> {
    return sidecarClient.request(`/api/agent-tasks/${taskId}`);
  },

  /** DELETE /api/agent-tasks/:taskId */
  delete(taskId: string): Promise<{ ok: boolean }> {
    return sidecarClient.request(`/api/agent-tasks/${taskId}`, { method: 'DELETE' });
  },

  /** POST /api/agent-tasks/clear — delete all terminal tasks for session. */
  clear(sessionId: string): Promise<{ deleted: number }> {
    return sidecarClient.request('/api/agent-tasks/clear', {
      method: 'POST',
      json: { sessionId },
    });
  },

  /** GET /api/agent-tasks/:taskId/messages — subagent transcript. */
  listMessages(taskId: string): Promise<{ messages: AgentTaskMessageWire[] }> {
    return sidecarClient.request(`/api/agent-tasks/${taskId}/messages`);
  },
};
