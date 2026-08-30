// AgentRun 持久记录只由 Route 响应写入；agent_run_* SSE 事件只写实时缓冲，终态即弃。
// AgentRun 记录只读：终态清理由 Session 生命周期负责，前端不提供删除入口。
import { create } from 'zustand';
import {
  agentRunsApi,
  type AgentRunSummary,
} from '../api/agentRuns.js';
import type { AgentRunMessage } from '@ema-agent/agent';
import type { ToolResult } from '@ema-agent/tools';

/** 在途运行的实时缓冲：只保存 agent_run_* 事件已经给出的字段。 */
export interface LiveAgentRun {
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly description?: string;
  readonly modelId?: string;
  readonly iteration: number;
  readonly toolCallCount: number;
}

/** 在途 transcript 条目：纯展示缓冲；持久回放由 transcript Route 提供。 */
export type LiveTranscriptEntry =
  | { readonly role: 'assistant' | 'reasoning'; readonly blockIndex: number; readonly text: string }
  | { readonly role: 'tool_call'; readonly blockIndex: number; readonly callId: string; readonly name: string; readonly args: unknown }
  | { readonly role: 'tool_result'; readonly result: ToolResult };

export interface AgentRunStoreState {
  /** 持久记录，唯一写入方是 Route 响应。 */
  runs: Map<string, AgentRunSummary>;
  /** 在途运行的实时进度，唯一写入方是 agent_run_* 事件。 */
  live: Map<string, LiveAgentRun>;
  /** 持久 transcript 回放；null = 加载中。 */
  transcripts: Map<string, AgentRunMessage[] | null>;
  /** 在途 transcript 流式缓冲，随 agent_run_started 建立、终态清除。 */
  liveTranscripts: Map<string, LiveTranscriptEntry[]>;
  loadingSessions: Set<string>;
  error: string | null;

  loadForSession(sessionId: string): Promise<void>;
  /** 终态事件后重读单条持久记录；返回是否成功（失败由调用方决定兜底）。 */
  refreshRun(agentRunId: string): Promise<boolean>;
  /** agent_run_started：建立实时缓冲并重读刚落库的记录行。 */
  startLive(run: LiveAgentRun & { readonly id: string }): void;
  patchLive(agentRunId: string, patch: Partial<Pick<LiveAgentRun, 'iteration' | 'toolCallCount'>>): void;
  appendLiveTranscript(agentRunId: string, entry: LiveTranscriptEntry): void;
  /** 终态：丢弃实时缓冲、让 transcript 缓存失效，并重读持久记录。 */
  finishLive(agentRunId: string): void;
  loadTranscript(agentRunId: string): Promise<void>;
  evictSession(sessionId: string): void;
}

export const useAgentRunStore = create<AgentRunStoreState>((set, get) => ({
  runs: new Map(),
  live: new Map(),
  transcripts: new Map(),
  liveTranscripts: new Map(),
  loadingSessions: new Set(),
  error: null,

  async loadForSession(sessionId) {
    set((state) => ({
      loadingSessions: addValue(state.loadingSessions, sessionId),
      error: null,
    }));

    try {
      const { items } = await agentRunsApi.list(sessionId);
      set((state) => {
        const incomingIds = new Set(items.map((item) => item.id));
        const next = new Map(state.runs);
        for (const [id, run] of next) {
          // 只删快照里确实不存在的行；快照携带的行走下方逐行新旧守卫，
          // 有实时缓冲的行必然比任何列表快照新，不能被快照的缺失删除。
          if (run.sessionId === sessionId && !incomingIds.has(id) && !state.live.has(id)) {
            next.delete(id);
          }
        }
        for (const run of items) {
          // 快照行比现有记录旧（完成态已先由 refreshRun 落地）时丢弃，防终态倒退。
          const existing = next.get(run.id);
          if (!existing || run.updatedAt >= existing.updatedAt) next.set(run.id, run);
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

  async refreshRun(agentRunId) {
    try {
      const run = await agentRunsApi.get(agentRunId);
      set((state) => {
        const existing = state.runs.get(run.id);
        if (existing && run.updatedAt < existing.updatedAt) return {};
        const next = new Map(state.runs);
        next.set(run.id, run);
        return { runs: next };
      });
      return true;
    } catch {
      return false;
    }
  },

  startLive(run) {
    set((state) => {
      const live = new Map(state.live);
      live.set(run.id, {
        sessionId: run.sessionId,
        startedAtMs: run.startedAtMs,
        ...(run.description !== undefined ? { description: run.description } : {}),
        ...(run.modelId !== undefined ? { modelId: run.modelId } : {}),
        iteration: run.iteration,
        toolCallCount: run.toolCallCount,
      });
      const liveTranscripts = new Map(state.liveTranscripts);
      liveTranscripts.set(run.id, []);
      return { live, liveTranscripts };
    });
    // 记录行先于事件落库，这里直接能读到真实的 running 行。
    void get().refreshRun(run.id);
  },

  patchLive(agentRunId, patch) {
    set((state) => {
      const existing = state.live.get(agentRunId);
      if (!existing) return {};
      const live = new Map(state.live);
      live.set(agentRunId, { ...existing, ...patch });
      return { live };
    });
  },

  appendLiveTranscript(agentRunId, entry) {
    set((state) => {
      const existing = state.liveTranscripts.get(agentRunId);
      if (!existing) return {};

      // 同一块的流式 delta 连续到达，按 blockIndex 合并。
      if (entry.role === 'assistant' || entry.role === 'reasoning') {
        const last = existing[existing.length - 1];
        if (last && last.role === entry.role && 'text' in last && last.blockIndex === entry.blockIndex) {
          const merged: LiveTranscriptEntry = {
            role: entry.role,
            blockIndex: entry.blockIndex,
            text: last.text + entry.text,
          };
          const liveTranscripts = new Map(state.liveTranscripts);
          liveTranscripts.set(agentRunId, [...existing.slice(0, -1), merged]);
          return { liveTranscripts };
        }
      }

      const liveTranscripts = new Map(state.liveTranscripts);
      liveTranscripts.set(agentRunId, [...existing, entry]);
      return { liveTranscripts };
    });
  },

  finishLive(agentRunId) {
    const sessionId = get().live.get(agentRunId)?.sessionId
      ?? get().runs.get(agentRunId)?.sessionId;
    set((state) => {
      const live = new Map(state.live);
      live.delete(agentRunId);
      const liveTranscripts = new Map(state.liveTranscripts);
      liveTranscripts.delete(agentRunId);
      const transcripts = new Map(state.transcripts);
      transcripts.delete(agentRunId);
      return { live, liveTranscripts, transcripts };
    });
    // 单条刷新失败时整刷兜底，不让记录永远停在 running。
    void get().refreshRun(agentRunId).then((ok) => {
      if (!ok && sessionId) void get().loadForSession(sessionId);
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

  evictSession(sessionId) {
    set((state) => {
      const runs = new Map(state.runs);
      const live = new Map(state.live);
      const transcripts = new Map(state.transcripts);
      const liveTranscripts = new Map(state.liveTranscripts);
      for (const [id, run] of runs) {
        if (run.sessionId === sessionId) {
          runs.delete(id);
          transcripts.delete(id);
          liveTranscripts.delete(id);
        }
      }
      for (const [id, entry] of live) {
        if (entry.sessionId === sessionId) {
          live.delete(id);
          liveTranscripts.delete(id);
        }
      }
      return {
        runs,
        live,
        transcripts,
        liveTranscripts,
        loadingSessions: withoutValue(state.loadingSessions, sessionId),
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
