// 管理各 Session 的 AgentRun 持久记录、实时进度与执行内容。
// AgentRun 记录只读：终态清理由 Session 生命周期负责，前端不提供删除入口。
import { create } from 'zustand';
import {
  agentRunsApi,
  type AgentRunSummary,
} from '../api/agentRuns.js';
import type { AgentRunMessage } from '@ema-agent/agent';

export interface LiveAgentRunInfo {
  startedAtMs: number;
  promptExcerpt: string;
  model: string;
  iteration: number;
  toolCallCount: number;
  elapsedMs: number;
}

export interface AgentRunState extends AgentRunSummary {
  /** 只保存当前进程收到的高频进度；持久字段仍以 AgentRun Route 记录为准。 */
  live?: LiveAgentRunInfo;
}

export interface AgentRunStoreState {
  runs: Map<string, AgentRunState>;
  transcripts: Map<string, AgentRunMessage[] | null>;
  loadingSessions: Set<string>;
  eventRevisions: Map<string, number>;
  error: string | null;

  loadForSession(sessionId: string): Promise<void>;
  upsert(run: Partial<AgentRunState> & { id: string }): void;
  loadTranscript(agentRunId: string): Promise<void>;
  appendLiveTranscript(
    agentRunId: string,
    role: AgentRunMessage['role'],
    content: AgentRunMessage['content'],
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
      const { items } = await agentRunsApi.list(sessionId);
      const currentRevision = get().eventRevisions.get(sessionId) ?? 0;

      // HTTP 请求发出后若已有实时事件到达，较早的响应不能覆盖刚更新的运行态。
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
        for (const run of items) {
          const live = next.get(run.id)?.live;
          next.set(
            run.id,
            live && run.status === 'running' ? { ...run, live } : { ...run },
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

      // 持久记录有版本时拒绝回退；SSE 高频进度没有版本，仍可合并 live 字段。
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

  async loadTranscript(agentRunId) {
    if (get().transcripts.has(agentRunId)) return;
    set((state) => {
      const transcripts = new Map(state.transcripts);
      transcripts.set(agentRunId, null);
      return { transcripts };
    });

    try {
      const { items } = await agentRunsApi.listMessages(agentRunId);
      set((state) => {
        const transcripts = new Map(state.transcripts);
        transcripts.set(agentRunId, [...items]);
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

      // 同 role 相邻文本块增量合并（流式 delta 逐块到达）；保留块身份 blockIndex。
      if ((role === 'assistant' || role === 'reasoning') && 'text' in content) {
        const last = existing[existing.length - 1];
        if (last?.role === role && 'text' in last.content) {
          const merged: AgentRunMessage = {
            ...last,
            content: { blockIndex: last.content.blockIndex, text: last.content.text + content.text },
          };
          transcripts.set(agentRunId, [...existing.slice(0, -1), merged]);
          return { transcripts };
        }
      }

      const lastSequence = existing[existing.length - 1]?.sequence ?? 0;
      const base = {
        id: `live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        agentRunId,
        sequence: lastSequence + 1,
        createdAt: Date.now(),
      };
      let message: AgentRunMessage;
      switch (role) {
        case 'assistant':
        case 'reasoning':
          if (!('text' in content)) return {};
          message = { ...base, role, content };
          break;
        case 'tool_call':
          if (!('callId' in content)) return {};
          message = { ...base, role, content };
          break;
        case 'tool_result':
          if (!('type' in content)) return {};
          message = { ...base, role, content };
          break;
      }
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
