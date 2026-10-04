// 共享身份与实时执行事实. 普通 Run/历史查询由面板局部状态持有.
import { create } from 'zustand';
import type { SubagentEvent, SubagentMessage } from '@ema-agent/agent';
import { subagentsApi, type SubagentRecord, type SubagentRunItem } from '../api/subagents.js';

export interface SubagentProgress {
  readonly sessionId: string;
  readonly runId: string;
  readonly startedAtMs: number;
  readonly iteration: number;
}
interface SubagentStoreState {
  subagents: ReadonlyMap<string, SubagentRecord>;
  progressById: ReadonlyMap<string, SubagentProgress>;
  /** 工具卡与面板共享当前/刚结束的 Run, 不缓存所有历史查询. */
  runsById: ReadonlyMap<string, SubagentRunItem>;
  /** 真实 Message 的实时更新, 闭合后不先清空, 避免查询回来前闪空. */
  streamingMessages: ReadonlyMap<string, readonly SubagentMessage[]>;
  openMessageIds: ReadonlySet<string>;
  /** 尚在屏幕交接期的工具进度, 与主 Tool 一样最多保留最近 200 条. */
  toolProgress: ReadonlyMap<string, readonly unknown[]>;
  /** 仅当前进程收到的启动关联, 不整批加载旧 ToolCall 映射. */
  toolReferences: ReadonlyMap<string, { sessionId: string; subagentId: string; runId: string }>;
  receiveEvent(sessionId: string, event: SubagentEvent): void;
  rememberSubagents(items: readonly SubagentRecord[]): void;
  loadForSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  refreshSubagent(subagentId: string): Promise<void>;
  evictSession(sessionId: string): void;
}

export const useSubagentStore = create<SubagentStoreState>((set, get) => ({
  subagents: new Map(),
  progressById: new Map(),
  runsById: new Map(),
  streamingMessages: new Map(),
  openMessageIds: new Set(),
  toolReferences: new Map(),
  toolProgress: new Map(),
  rememberSubagents(items) {
    set(state => {
      const subagents = new Map(state.subagents);
      for (const item of items) {
        const old = subagents.get(item.id);
        if (!old || old.updatedAt <= item.updatedAt) {
          subagents.set(item.id, item);
        }
      }
      return { subagents };
    });
  },
  async loadForSession(sessionId, signal) {
    let cursor: { updatedAt: number; id: string } | undefined;
    do {
      const page = await subagentsApi.list(sessionId, cursor, signal);
      if (signal?.aborted) {
        return;
      }
      get().rememberSubagents(page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  },
  async refreshSubagent(subagentId) {
    try {
      get().rememberSubagents([await subagentsApi.get(subagentId)]);
    } catch {
      // 面板的查询负责展示错误, 后台刷新不制造未处理拒绝.
    }
  },
  receiveEvent(sessionId, event) {
    set(state => {
      if (event.type === 'subagent_started') {
        const progressById = new Map(state.progressById);
        progressById.set(event.subagentId, { sessionId, runId: event.runId, startedAtMs: event.startedAt, iteration: 0 });
        const toolReferences = new Map(state.toolReferences);
        toolReferences.set(event.parentToolCallId, { sessionId, subagentId: event.subagentId, runId: event.runId });
        return { progressById, toolReferences };
      }
      if (event.type === 'message_updated') {
        const openMessageIds = new Set(state.openMessageIds);
        if (event.streaming) {
          openMessageIds.add(event.message.id);
        } else {
          openMessageIds.delete(event.message.id);
        }
        const streamingMessages = new Map(state.streamingMessages);
        const messages = new Map((streamingMessages.get(event.subagentId) ?? []).map(message => [message.id, message]));
        messages.set(event.message.id, event.message);
        streamingMessages.set(
          event.subagentId,
          [...messages.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        );
        return { streamingMessages, openMessageIds };
      }
      const progress = state.progressById.get(event.subagentId);
      if (event.type === 'iteration_started') {
        if (progress?.runId !== event.runId) {
          return state;
        }
        const progressById = new Map(state.progressById);
        progressById.set(event.subagentId, { ...progress, iteration: event.iteration });
        const runsById = new Map(state.runsById);
        runsById.set(event.runId, event.run);
        return { progressById, runsById };
      }
      if (event.type === 'tool_progress') {
        const toolProgress = new Map(state.toolProgress);
        toolProgress.set(event.toolCallId, [...(toolProgress.get(event.toolCallId) ?? []), event.progress].slice(-200));
        return { toolProgress };
      }
      if (event.type === 'tool_result') {
        return state;
      }
      const runsById = new Map(state.runsById);
      runsById.set(event.runId, event.run);
      const progressById = new Map(state.progressById);
      if (progress?.runId === event.runId) {
        progressById.delete(event.subagentId);
      }
      return { runsById, progressById };
    });
    if (event.type === 'subagent_started' || event.type === 'subagent_completed'
      || event.type === 'subagent_failed'
      || event.type === 'subagent_aborted') {
      void get().refreshSubagent(event.subagentId);
    }
  },
  evictSession(sessionId) {
    set(state => {
      const subagents = new Map(state.subagents);
      const progressById = new Map(state.progressById);
      const streamingMessages = new Map(state.streamingMessages);
      const runsById = new Map(state.runsById);
      const toolReferences = new Map(state.toolReferences);
      const openMessageIds = new Set(state.openMessageIds);
      const toolProgress = new Map(state.toolProgress);
      const ids = new Set([...subagents.values()].filter(item => item.sessionId === sessionId).map(item => item.id));
      for (const [id, progress] of progressById) {
        if (progress.sessionId === sessionId) {
          ids.add(id);
        }
      }
      for (const ref of toolReferences.values()) {
        if (ref.sessionId === sessionId) {
          ids.add(ref.subagentId);
        }
      }
      for (const id of ids) {
        for (const message of streamingMessages.get(id) ?? []) {
          openMessageIds.delete(message.id);
          if (Array.isArray(message.blocks)) {
            for (const block of message.blocks) {
              if (block.type === 'tool_use') {
                toolProgress.delete(block.id);
              }
            }
          }
        }
        subagents.delete(id);
        progressById.delete(id);
        streamingMessages.delete(id);
      }
      for (const [id, run] of runsById) {
        if (ids.has(run.subagentId)) {
          runsById.delete(id);
        }
      }
      for (const [id, ref] of toolReferences) {
        if (ref.sessionId === sessionId) {
          toolReferences.delete(id);
        }
      }
      return {
        subagents,
        progressById,
        streamingMessages,
        runsById,
        toolReferences,
        openMessageIds,
        toolProgress
      };
    });
  },
}));
