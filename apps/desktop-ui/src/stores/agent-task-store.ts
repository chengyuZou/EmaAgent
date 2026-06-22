import { create } from 'zustand';
import { agentTasksApi, type AgentTaskWire, type AgentTaskMessageWire, type TaskStatus } from '../api/agent-tasks.js';
import { turnsApi } from '../api/turns.js';

export type { AgentTaskWire, AgentTaskMessageWire, TaskStatus };

// ── Runtime task shape (enriched with live SSE data) ─────────────────────────

export interface LiveTaskInfo {
  /** Epoch ms of subagent_started. */
  startedAtMs:   number;
  /** Most recent promptExcerpt from subagent_started. */
  promptExcerpt: string;
  /** Model name. */
  model:         string;
  /** Current iteration count (from subagent_progress). */
  iteration:     number;
  /** Total tool calls so far (from subagent_progress). */
  toolCallCount: number;
  /** Elapsed ms (from subagent_progress). */
  elapsedMs:     number;
}

export interface AgentTaskState extends AgentTaskWire {
  /** Live data from SSE (only present while running). */
  live?: LiveTaskInfo;
  /** parentTurnId — needed to call abortSubagent(). */
  parentTurnId?: string;
  /** First 200 chars of the prompt — set on subagent_started, survives completion. */
  description?: string;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export interface AgentTaskStoreState {
  /** task.id → task. Flat map — use parentId to build a tree in UI. */
  tasks:         Map<string, AgentTaskState>;
  /** Currently-loading transcript. taskId → messages | null (null = loading). */
  transcripts:   Map<string, AgentTaskMessageWire[] | null>;
  loadingFor:    string | null;   // which sessionId is being bulk-loaded
  error:         string | null;

  /** Load all tasks for a session from the server. Replaces existing entries. */
  loadForSession(sessionId: string): Promise<void>;

  /** Upsert a task (called by SSE handlers in conversation-store). */
  upsert(task: Partial<AgentTaskState> & { id: string }): void;

  /** Delete a task (cancel if running, then hard-delete). */
  deleteTask(taskId: string, parentTurnId: string | undefined): Promise<void>;

  /** Batch-clear terminal tasks for session. */
  clearTerminal(sessionId: string): Promise<void>;

  /** Load transcript for a task (lazy, cached). */
  loadTranscript(taskId: string): Promise<void>;

  /** Evict all data for a session (called on session delete). */
  evictSession(sessionId: string): void;
}

export const useAgentTaskStore = create<AgentTaskStoreState>((set, get) => ({
  tasks:       new Map(),
  transcripts: new Map(),
  loadingFor:  null,
  error:       null,

  async loadForSession(sessionId) {
    set({ loadingFor: sessionId, error: null });
    try {
      const { tasks: raw } = await agentTasksApi.list(sessionId);
      set((s) => {
        const next = new Map(s.tasks);
        // Remove old entries for this session, then repopulate.
        for (const [id, t] of next) {
          if (t.sessionId === sessionId) next.delete(id);
        }
        for (const t of raw) next.set(t.id, t);
        return { tasks: next, loadingFor: null };
      });
    } catch (err: unknown) {
      set({ loadingFor: null, error: err instanceof Error ? err.message : String(err) });
    }
  },

  upsert(partial) {
    set((s) => {
      const next  = new Map(s.tasks);
      const existing = next.get(partial.id);
      next.set(partial.id, { ...(existing ?? {} as AgentTaskState), ...partial } as AgentTaskState);
      return { tasks: next };
    });
  },

  async deleteTask(taskId, parentTurnId) {
    // Cancel in-flight subagent first if we know the parent turn.
    const task = get().tasks.get(taskId);
    if (task && (task.status === 'running' || task.status === 'waiting_user') && parentTurnId) {
      await turnsApi.abortSubagent(parentTurnId, taskId).catch(() => {});
    }
    await agentTasksApi.delete(taskId);
    set((s) => {
      const next = new Map(s.tasks);
      next.delete(taskId);
      const trans = new Map(s.transcripts);
      trans.delete(taskId);
      return { tasks: next, transcripts: trans };
    });
  },

  async clearTerminal(sessionId) {
    await agentTasksApi.clear(sessionId);
    set((s) => {
      const next = new Map(s.tasks);
      for (const [id, t] of next) {
        if (t.sessionId === sessionId &&
            (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')) {
          next.delete(id);
        }
      }
      return { tasks: next };
    });
  },

  async loadTranscript(taskId) {
    if (get().transcripts.has(taskId)) return;
    set((s) => {
      const trans = new Map(s.transcripts);
      trans.set(taskId, null);  // mark loading
      return { transcripts: trans };
    });
    try {
      const { messages } = await agentTasksApi.listMessages(taskId);
      set((s) => {
        const trans = new Map(s.transcripts);
        trans.set(taskId, messages);
        return { transcripts: trans };
      });
    } catch {
      set((s) => {
        const trans = new Map(s.transcripts);
        trans.delete(taskId);
        return { transcripts: trans };
      });
    }
  },

  evictSession(sessionId) {
    set((s) => {
      const next  = new Map(s.tasks);
      const trans = new Map(s.transcripts);
      for (const [id, t] of next) {
        if (t.sessionId === sessionId) {
          next.delete(id);
          trans.delete(id);
        }
      }
      return { tasks: next, transcripts: trans };
    });
  },
}));
