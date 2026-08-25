// 管理各 Session 的 AgentRun 快照、实时进度、取消清理与执行记录。
import { create } from 'zustand';
import {
  agentRunsApi,
  type AgentRunWire,
  type AgentRunMessageWire,
  type AgentRunMessageRole,
  type AgentRunStatus,
  type AssistantMessageContent,
} from '../api/agentRuns.js';
import { turnsApi } from '../api/turns.js';

export type { AgentRunWire, AgentRunMessageWire, AgentRunStatus };

export interface LiveAgentRunInfo {
  startedAtMs: number;
  promptExcerpt: string;
  model: string;
  iteration: number;
  toolCallCount: number;
  elapsedMs: number;
}

export interface AgentRunState extends AgentRunWire {
  /** 只保存当前进程收到的高频进度；持久字段仍以 AgentRun 快照为准。 */
  live?: LiveAgentRunInfo;
}

export interface AgentRunStoreState {
  runs: Map<string, AgentRunState>;
  transcripts: Map<string, AgentRunMessageWire[] | null>;
  loadingSessions: Set<string>;
  eventRevisions: Map<string, number>;
  error: string | null;

  loadForSession(sessionId: string): Promise<void>;
  upsert(run: Partial<AgentRunState> & { id: string }): void;
  deleteRun(agentRunId: string, parentTurnId: string | undefined): Promise<void>;
  clearTerminal(sessionId: string): Promise<void>;
  loadTranscript(agentRunId: string): Promise<void>;
  appendLiveTranscript(
    agentRunId: string,
    role: AgentRunMessageRole,
    content: AgentRunMessageWire['content'],
  ): void;
  evictSession(sessionId: string): void;
}

export const useAgentRunStore = create<AgentRunStoreState>((set, get) => ({
  runs: new Map(),
  transcripts: new Map(),
  loadingSessions: new Set(),
  eventRevisions: new Map(),
  error: null,

  async loadForSession(sessionId) {
    const revisionAtStart = get().eventRevisions.get(sessionId) ?? 0;
    set((state) => ({
      loadingSessions: addValue(state.loadingSessions, sessionId),
      error: null,
    }));

    try {
      const { runs } = await agentRunsApi.list(sessionId);
      const currentRevision = get().eventRevisions.get(sessionId) ?? 0;

      // HTTP 快照发出后若已有实时事件到达，旧响应不能覆盖刚更新的运行态。
      if (currentRevision !== revisionAtStart) {
        set((state) => ({
          loadingSessions: withoutValue(state.loadingSessions, sessionId),
        }));
        await get().loadForSession(sessionId);
        return;
      }

      set((state) => {
        const next = new Map(state.runs);
        for (const [id, run] of next) {
          if (run.sessionId === sessionId) next.delete(id);
        }
        for (const run of runs) {
          const live = next.get(run.id)?.live;
          next.set(
            run.id,
            live && run.status === 'running' ? { ...run, live } : run,
          );
        }
        return {
          runs: next,
          loadingSessions: withoutValue(state.loadingSessions, sessionId),
        };
      });
    } catch (error: unknown) {
      set((state) => ({
        loadingSessions: withoutValue(state.loadingSessions, sessionId),
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  },

  upsert(partial) {
    set((state) => {
      const next = new Map(state.runs);
      const existing = next.get(partial.id);
      const sessionId = partial.sessionId ?? existing?.sessionId;

      // 持久快照有版本时拒绝回退；SSE 高频进度没有版本，仍可合并 live 字段。
      if (
        partial.version !== undefined
        && existing?.version !== undefined
        && partial.version <= existing.version
      ) {
        return sessionId
          ? { eventRevisions: incrementRevision(state.eventRevisions, sessionId) }
          : {};
      }

      next.set(
        partial.id,
        { ...(existing ?? {} as AgentRunState), ...partial } as AgentRunState,
      );
      return {
        runs: next,
        ...(sessionId
          ? { eventRevisions: incrementRevision(state.eventRevisions, sessionId) }
          : {}),
      };
    });
  },

  async deleteRun(agentRunId, parentTurnId) {
    const run = get().runs.get(agentRunId);
    set({ error: null });
    try {
      // 先确认运行时已停止，再清理持久记录，避免 UI 消失但子智能体仍在后台执行。
      if (run?.status === 'running') {
        if (!parentTurnId) {
          throw new Error('缺少父 Turn，无法安全取消仍在运行的子智能体');
        }
        await turnsApi.abortSubagent(parentTurnId, agentRunId);
      }
      await agentRunsApi.delete(agentRunId);
    } catch (error: unknown) {
      set({ error: error instanceof Error ? error.message : '删除 AgentRun 失败' });
      throw error;
    }

    set((state) => ({
      runs: withoutKey(state.runs, agentRunId),
      transcripts: withoutKey(state.transcripts, agentRunId),
      error: null,
    }));
  },

  async clearTerminal(sessionId) {
    await agentRunsApi.clear(sessionId);
    set((state) => {
      const next = new Map(state.runs);
      const transcripts = new Map(state.transcripts);
      for (const [id, run] of next) {
        if (run.sessionId === sessionId && run.status !== 'running') {
          next.delete(id);
          transcripts.delete(id);
        }
      }
      return { runs: next, transcripts };
    });
  },

  async loadTranscript(agentRunId) {
    if (get().transcripts.has(agentRunId)) return;
    set((state) => {
      const transcripts = new Map(state.transcripts);
      transcripts.set(agentRunId, null);
      return { transcripts };
    });

    try {
      const { messages } = await agentRunsApi.listMessages(agentRunId);
      set((state) => {
        const transcripts = new Map(state.transcripts);
        transcripts.set(agentRunId, messages);
        return { transcripts };
      });
    } catch {
      set((state) => ({
        transcripts: withoutKey(state.transcripts, agentRunId),
      }));
    }
  },

  appendLiveTranscript(agentRunId, role, content) {
    set((state) => {
      const transcripts = new Map(state.transcripts);
      const existing = transcripts.get(agentRunId) ?? [];

      if (role === 'assistant' || role === 'reasoning') {
        const last = existing[existing.length - 1];
        if (last?.role === role) {
          const previousText = (last.content as AssistantMessageContent).text;
          const nextText = (content as AssistantMessageContent).text;
          transcripts.set(agentRunId, [
            ...existing.slice(0, -1),
            { ...last, content: { text: previousText + nextText } },
          ]);
          return { transcripts };
        }
      }

      const message: AgentRunMessageWire = {
        id: `live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        agentRunId,
        role,
        content,
        createdAt: Date.now(),
      };
      transcripts.set(agentRunId, [...existing, message]);
      return { transcripts };
    });
  },

  evictSession(sessionId) {
    set((state) => {
      const runs = new Map(state.runs);
      const transcripts = new Map(state.transcripts);
      for (const [id, run] of runs) {
        if (run.sessionId === sessionId) {
          runs.delete(id);
          transcripts.delete(id);
        }
      }
      return {
        runs,
        transcripts,
        loadingSessions: withoutValue(state.loadingSessions, sessionId),
        eventRevisions: withoutKey(state.eventRevisions, sessionId),
      };
    });
  },
}));

function addValue<T>(values: Set<T>, value: T): Set<T> {
  const next = new Set(values);
  next.add(value);
  return next;
}

function withoutValue<T>(values: Set<T>, value: T): Set<T> {
  const next = new Set(values);
  next.delete(value);
  return next;
}

function withoutKey<K, V>(values: Map<K, V>, key: K): Map<K, V> {
  const next = new Map(values);
  next.delete(key);
  return next;
}

function incrementRevision(
  revisions: Map<string, number>,
  sessionId: string,
): Map<string, number> {
  const next = new Map(revisions);
  next.set(sessionId, (next.get(sessionId) ?? 0) + 1);
  return next;
}
