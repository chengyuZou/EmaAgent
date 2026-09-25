// 持久 Subagent 摘要来自 Route; WebSocket 只维护执行进度和未闭合的 Assistant Message.
import { create } from 'zustand';
import {
  subagentsApi,
  type SubagentSummary,
} from '../api/subagents.js';
import type { SubagentEvent } from '@ema-agent/agent';
import type { AssistantOutputBlock } from './turn.js';

export interface SubagentProgress {
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly description?: string;
  readonly modelId?: string;
  readonly iteration: number;
  readonly toolCallCount: number;
}

/** SSE 尚未闭合的 Assistant Message, 与持久消息使用同一套展示块. */
export interface SubagentStreamingMessage {
  readonly iteration: number;
  readonly blocks: readonly AssistantOutputBlock[];
}

type SubagentMessageEvent = Exclude<SubagentEvent, {
  readonly type: 'subagent_started' | 'subagent_completed' | 'subagent_failed' | 'subagent_aborted';
}>;

export interface SubagentStoreState {
  /** 持久记录, 唯一写入方是 Route 响应. */
  subagents: Map<string, SubagentSummary>;
  /** 每个 Session 的 ToolCallId 到子代理身份, 来自同一次 Session 列表响应. */
  invocationsBySession: Map<string, Map<string, string>>;
  /** 在途运行的实时进度, 唯一写入方是 subagent_* 事件. */
  progressById: Map<string, SubagentProgress>;
  streamingMessages: Map<string, readonly SubagentStreamingMessage[]>;
  loadingSessions: Set<string>;
  error: string | null;

  loadForSession(sessionId: string): Promise<void>;
  /** 终态事件后重读单条持久记录, 返回是否成功(失败由调用方决定兜底). */
  refreshSubagent(subagentId: string): Promise<boolean>;
  /** subagent_started, 建立实时缓冲并重读刚落库的记录行。 */
  startProgress(progress: SubagentProgress & { readonly id: string }): void;
  receiveMessageEvent(event: SubagentMessageEvent): void;
  /** 终态丢弃流式消息, 然后重读持久记录. */
  finishProgress(subagentId: string): void;
  evictSession(sessionId: string): void;
}

export const useSubagentStore = create<SubagentStoreState>((set, get) => ({
  subagents: new Map(),
  invocationsBySession: new Map(),
  progressById: new Map(),
  streamingMessages: new Map(),
  loadingSessions: new Set(),
  error: null,

  async loadForSession(sessionId) {
    set((state) => ({
      loadingSessions: addValue(state.loadingSessions, sessionId),
      error: null,
    }));

    try {
      const { items, invocations } = await subagentsApi.list(sessionId);
      set((state) => {
        const incomingIds = new Set(items.map((item) => item.id));
        const next = new Map(state.subagents);
        for (const [id, subagent] of next) {
          // 只删快照里确实不存在的行；快照携带的行走下方逐行新旧守卫，
          // 有实时缓冲的行必然比任何列表快照新，不能被快照的缺失删除。
          if (subagent.sessionId === sessionId && !incomingIds.has(id) && !state.progressById.has(id)) {
            next.delete(id);
          }
        }
        for (const subagent of items) {
          // 列表响应可能早于终态单条响应返回，较旧的摘要不能覆盖较新的终态。
          const existing = next.get(subagent.id);
          if (!existing || subagent.updatedAt >= existing.updatedAt) {
            next.set(subagent.id, subagent);
          }
        }
        const sessionInvocations = new Map<string, string>();
        for (const invocation of invocations) {
          sessionInvocations.set(invocation.toolCallId, invocation.subagentId);
        }
        const invocationsBySession = new Map(state.invocationsBySession);
        invocationsBySession.set(sessionId, sessionInvocations);
        return {
          subagents: next,
          invocationsBySession,
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

  async refreshSubagent(subagentId) {
    try {
      const subagent = await subagentsApi.get(subagentId);
      set((state) => {
        const existing = state.subagents.get(subagent.id);
        if (existing && subagent.updatedAt < existing.updatedAt) return {};
        const next = new Map(state.subagents);
        next.set(subagent.id, subagent);
        return { subagents: next };
      });
      return true;
    } catch {
      return false;
    }
  },

  startProgress(progress) {
    set((state) => {
      const progressById = new Map(state.progressById);
      progressById.set(progress.id, {
        sessionId: progress.sessionId,
        startedAtMs: progress.startedAtMs,
        ...(progress.description !== undefined ? { description: progress.description } : {}),
        ...(progress.modelId !== undefined ? { modelId: progress.modelId } : {}),
        iteration: progress.iteration,
        toolCallCount: progress.toolCallCount,
      });
      const streamingMessages = new Map(state.streamingMessages);
      streamingMessages.set(progress.id, []);
      return { progressById, streamingMessages };
    });
    // 记录行先于事件落库，这里直接能读到真实的 running 行。
    void get().loadForSession(progress.sessionId);
  },

  receiveMessageEvent(event) {
    set((state) => {
      const progress = state.progressById.get(event.subagentId);
      const messages = state.streamingMessages.get(event.subagentId);
      if (!progress || !messages) return {};

      const progressById = new Map(state.progressById);
      const streamingMessages = new Map(state.streamingMessages);
      if (event.type === 'iteration_started') {
        progressById.set(event.subagentId, { ...progress, iteration: event.iteration });
        streamingMessages.set(event.subagentId, [
          ...messages.map(message => ({
            ...message,
            blocks: message.blocks.map(block => block.type === 'thinking'
              ? { ...block, done: true }
              : block),
          })),
          { iteration: event.iteration, blocks: [] },
        ]);
        return { progressById, streamingMessages };
      }

      if (event.type === 'tool_result') {
        streamingMessages.set(event.subagentId, messages.map(message => ({
          ...message,
          blocks: message.blocks.map(block => {
            if (block.type !== 'tool_use' || block.callId !== event.result.toolCallId) return block;
            const content = event.result.content;
            const errorText = typeof content === 'string'
              ? content
              : content.find(part => part.type === 'text')?.text ?? '工具执行失败';
            return {
              ...block,
              status: event.result.isError ? 'failed' as const : 'succeeded' as const,
              output: event.result.data ?? content,
              durationMs: event.result.durationMs,
              ...(event.result.isError ? {
                error: { code: event.result.errorCode ?? 'tool/error', message: errorText },
              } : {}),
            };
          }),
        })));
        return { streamingMessages };
      }

      const current = messages.at(-1) ?? { iteration: progress.iteration, blocks: [] };
      const blocks = [...current.blocks];
      const index = blocks.findIndex(block => block.blockIndex === event.blockIndex);
      const previous = index >= 0 ? blocks[index] : undefined;
      let nextBlock: AssistantOutputBlock;

      if (event.type === 'text_delta') {
        nextBlock = {
          type: 'text',
          blockIndex: event.blockIndex,
          text: previous?.type === 'text' ? previous.text + event.delta : event.delta,
        };
      } else if (event.type === 'thinking_delta') {
        nextBlock = {
          type: 'thinking',
          blockIndex: event.blockIndex,
          thinking: previous?.type === 'thinking' ? previous.thinking + event.delta : event.delta,
          done: false,
        };
      } else {
        nextBlock = {
          type: 'tool_use',
          blockIndex: event.blockIndex,
          callId: event.toolCallId,
          name: event.toolName,
          args: event.args,
          startedAt: Date.now(),
          status: 'running',
        };
        progressById.set(event.subagentId, {
          ...progress,
          toolCallCount: progress.toolCallCount + 1,
        });
      }

      if (index >= 0) blocks[index] = nextBlock;
      else blocks.push(nextBlock);
      blocks.sort((left, right) => left.blockIndex - right.blockIndex);
      if (event.type !== 'thinking_delta') {
        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
          const block = blocks[blockIndex];
          if (block?.type === 'thinking' && block.blockIndex < event.blockIndex) {
            blocks[blockIndex] = { ...block, done: true };
          }
        }
      }
      streamingMessages.set(event.subagentId, [
        ...messages.slice(0, -1),
        { ...current, blocks },
      ]);
      return { progressById, streamingMessages };
    });
  },

  finishProgress(subagentId) {
    set((state) => {
      const progressById = new Map(state.progressById);
      progressById.delete(subagentId);
      const streamingMessages = new Map(state.streamingMessages);
      streamingMessages.delete(subagentId);
      return { progressById, streamingMessages };
    });
    void get().refreshSubagent(subagentId);
  },

  evictSession(sessionId) {
    set((state) => {
      const subagents = new Map(state.subagents);
      const invocationsBySession = new Map(state.invocationsBySession);
      invocationsBySession.delete(sessionId);
      const progressById = new Map(state.progressById);
      const streamingMessages = new Map(state.streamingMessages);
      for (const [id, subagent] of subagents) {
        if (subagent.sessionId === sessionId) {
          subagents.delete(id);
          streamingMessages.delete(id);
        }
      }
      for (const [id, entry] of progressById) {
        if (entry.sessionId === sessionId) {
          progressById.delete(id);
          streamingMessages.delete(id);
        }
      }
      return {
        subagents,
        invocationsBySession,
        progressById,
        streamingMessages,
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
