// 每个 Session 的消息历史与流式状态：历史原样保存后端消息与 Turn 记录（零变形），
// 流式内容与乐观输入是独立的瞬态（按 sessionId/turnId/toolCallId 关联），终态重拉历史收口。
import { create } from 'zustand';
import type { NarrativeEvent } from '@ema-agent/narrative';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/session';
import type { ToolError } from '@ema-agent/tools';
import type { NarrativeStatusViewData } from '@ema-agent/builtin-tools/ui';
import type { TurnInputPart } from '@ema-agent/turn';
import { sessionsApi } from '../../api/sessions.js';
import { useSessionHistory } from '../history/sessionHistory.js';
import { useSessionStore } from '../../stores/session.js';
import type {
  SessionHistoryMessage,
  SessionHistoryTurn,
} from '../../api/sessions.js';
import type { TurnAttachmentInput } from '../../api/turns.js';

// ── 瞬态类型（全部是不落库的前端状态，按后端身份关联） ─────────────────────────

/** 流式展示项：文本/思考累计、工具调用占位、Narrative 状态行。终态后由持久消息替换。 */
export type StreamItem =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string; readonly done: boolean }
  | {
      readonly type: 'tool_use';
      readonly callId: string;
      readonly name: string;
      readonly args?: unknown;
      readonly partialArgs?: string;
      readonly startedAt: number;
      readonly permissionPending?: boolean;
      readonly output?: unknown;
      readonly error?: ToolError;
      readonly durationMs?: number;
    }
  | ({
      readonly type: 'narrative_status';
    } & NarrativeStatusViewData);

export interface TurnStreamState {
  readonly turnId: string;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  readonly startedAt: number;
  readonly items: readonly StreamItem[];
  readonly thinkingActive: boolean;
  readonly iteration: number | null;
}

/** 已提交但尚未在历史中出现的用户输入；turn_started 重拉历史后清除。 */
export interface PendingInput {
  readonly parts: readonly TurnInputPart[];
  readonly createdAt: number;
}

interface MessagesState {
  readonly messages: ReadonlyMap<string, readonly SessionHistoryMessage[]>;
  readonly turns: ReadonlyMap<string, readonly SessionHistoryTurn[]>;
  readonly loadedSessions: ReadonlySet<string>;
  readonly loadingSessions: ReadonlySet<string>;
  readonly streamBySession: ReadonlyMap<string, TurnStreamState>;
  readonly pendingInputBySession: ReadonlyMap<string, PendingInput>;
  readonly stopReasonBySession: ReadonlyMap<string, string>;
  readonly error: string | null;

  loadMessages(sessionId: string): Promise<void>;
  reloadMessages(sessionId: string): Promise<void>;
  setPendingInput(sessionId: string, input: PendingInput | null): void;

  beginStream(
    sessionId: string,
    turnId: string,
    executionProfile: ExecutionProfile,
    narrativePolicy: NarrativePolicy,
  ): void;
  appendTextDelta(sessionId: string, delta: string): void;
  appendThinkingDelta(sessionId: string, delta: string): void;
  upsertPartialToolCall(sessionId: string, callId: string, name: string, argsDelta: string): void;
  completeToolCall(sessionId: string, callId: string, name: string, args: unknown): void;
  setToolResult(
    sessionId: string,
    callId: string,
    result: { output?: unknown; error?: ToolError; durationMs: number },
  ): void;
  setToolPermissionPending(sessionId: string, callId: string, pending: boolean): void;
  markThinkingDone(sessionId: string, blockIndex: number): void;
  narrativeRecallStarted(sessionId: string): void;
  narrativeRecallCompleted(
    sessionId: string,
    event: Extract<NarrativeEvent, { type: 'narrative_recall_completed' }>,
  ): void;
  narrativeRecallFailed(sessionId: string, message: string): void;
  setIteration(sessionId: string, iteration: number): void;
  /** Turn 正常终态：重拉历史后撤下流态。 */
  settleStream(sessionId: string): void;
  /** Turn 失败/中止：重拉历史收口部分内容，停留原因短暂展示。 */
  abortStream(sessionId: string, reason: string): void;
  evictSession(sessionId: string): void;
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function patchStream(
  state: Pick<MessagesState, 'streamBySession'>,
  sessionId: string,
  patch: (stream: TurnStreamState) => TurnStreamState | undefined,
): Pick<MessagesState, 'streamBySession'> | Record<string, never> {
  const current = state.streamBySession.get(sessionId);
  if (!current) return {};
  const next = patch(current);
  if (!next) return {};
  const streamBySession = new Map(state.streamBySession);
  streamBySession.set(sessionId, next);
  return { streamBySession };
}

function appendStreamText(items: readonly StreamItem[], delta: string): StreamItem[] {
  const last = items[items.length - 1];
  if (last?.type === 'text') {
    return [...items.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...items, { type: 'text', text: delta }];
}

function appendStreamThinking(items: readonly StreamItem[], delta: string): StreamItem[] {
  const last = items[items.length - 1];
  if (last?.type === 'thinking') {
    return [...items.slice(0, -1), { ...last, thinking: last.thinking + delta }];
  }
  return [...items, { type: 'thinking', thinking: delta, done: false }];
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useMessages = create<MessagesState>((set, get) => ({
  messages: new Map(),
  turns: new Map(),
  loadedSessions: new Set(),
  loadingSessions: new Set(),
  streamBySession: new Map(),
  pendingInputBySession: new Map(),
  stopReasonBySession: new Map(),
  error: null,

  async loadMessages(sessionId) {
    if (get().loadedSessions.has(sessionId)) return;
    if (get().loadingSessions.has(sessionId)) return;

    set((s) => ({ loadingSessions: new Set([...s.loadingSessions, sessionId]) }));
    try {
      const { messages, turns } = await sessionsApi.listMessages(sessionId);
      set((s) => {
        const nextMessages = new Map(s.messages);
        nextMessages.set(sessionId, messages);
        const nextTurns = new Map(s.turns);
        nextTurns.set(sessionId, turns);
        const loading = new Set(s.loadingSessions);
        loading.delete(sessionId);
        const loaded = new Set(s.loadedSessions);
        loaded.add(sessionId);
        // 历史落地后，该 Session 的乐观输入已被持久消息覆盖。
        const pending = new Map(s.pendingInputBySession);
        pending.delete(sessionId);
        return {
          messages: nextMessages,
          turns: nextTurns,
          loadingSessions: loading,
          loadedSessions: loaded,
          pendingInputBySession: pending,
        };
      });
    } catch (error) {
      set((s) => {
        const loading = new Set(s.loadingSessions);
        loading.delete(sessionId);
        return {
          error: error instanceof Error ? error.message : '消息加载失败',
          loadingSessions: loading,
        };
      });
    }
  },

  async reloadMessages(sessionId) {
    set((s) => {
      const loaded = new Set(s.loadedSessions);
      loaded.delete(sessionId);
      return { loadedSessions: loaded };
    });
    await get().loadMessages(sessionId);
  },

  setPendingInput(sessionId, input) {
    set((s) => {
      const pending = new Map(s.pendingInputBySession);
      if (input) pending.set(sessionId, input);
      else pending.delete(sessionId);
      return { pendingInputBySession: pending };
    });
  },

  // ── 流式 action ─────────────────────────────────────────────────────────

  beginStream(sessionId, turnId, executionProfile, narrativePolicy) {
    set((s) => {
      const streamBySession = new Map(s.streamBySession);
      streamBySession.set(sessionId, {
        turnId,
        executionProfile,
        narrativePolicy,
        startedAt: Date.now(),
        items: [],
        thinkingActive: false,
        iteration: null,
      });
      const stops = new Map(s.stopReasonBySession);
      stops.delete(sessionId);
      return { streamBySession, stopReasonBySession: stops };
    });
    // Turn 接受后用户消息已由后端持久化；重拉让真实消息（含 skill_ref/attachment_ref 块）就位。
    void get().reloadMessages(sessionId);
  },

  appendTextDelta(sessionId, delta) {
    set((s) => patchStream(s, sessionId, (stream) => ({
      ...stream,
      items: appendStreamText(stream.items, delta),
    })));
  },

  appendThinkingDelta(sessionId, delta) {
    set((s) => patchStream(s, sessionId, (stream) => ({
      ...stream,
      items: appendStreamThinking(stream.items, delta),
      thinkingActive: true,
    })));
  },

  upsertPartialToolCall(sessionId, callId, name, argsDelta) {
    set((s) => patchStream(s, sessionId, (stream) => {
      const index = stream.items.findIndex(
        (item) => item.type === 'tool_use' && item.callId === callId,
      );
      if (index < 0) {
        return {
          ...stream,
          items: [
            ...stream.items,
            { type: 'tool_use', callId, name, partialArgs: argsDelta, startedAt: Date.now() },
          ],
        };
      }
      return {
        ...stream,
        items: stream.items.map((item, i) =>
          i === index && item.type === 'tool_use'
            ? { ...item, partialArgs: (item.partialArgs ?? '') + argsDelta }
            : item,
        ),
      };
    }));
  },

  completeToolCall(sessionId, callId, name, args) {
    set((s) => patchStream(s, sessionId, (stream) => {
      const index = stream.items.findIndex(
        (item) => item.type === 'tool_use' && item.callId === callId,
      );
      const entry = {
        type: 'tool_use' as const,
        callId,
        name,
        args,
        startedAt:
          index >= 0 && stream.items[index]!.type === 'tool_use'
            ? (stream.items[index] as { startedAt: number }).startedAt
            : Date.now(),
      };
      if (index < 0) return { ...stream, items: [...stream.items, entry] };
      return {
        ...stream,
        items: stream.items.map((item, i) => (i === index ? { ...entry } : item)),
      };
    }));
  },

  setToolResult(sessionId, callId, result) {
    set((s) => patchStream(s, sessionId, (stream) => ({
      ...stream,
      items: stream.items.map((item) =>
        item.type === 'tool_use' && item.callId === callId
          ? {
              ...item,
              output: result.output,
              error: result.error,
              durationMs: result.durationMs,
              permissionPending: undefined,
            }
          : item,
      ),
    })));
  },

  setToolPermissionPending(sessionId, callId, pending) {
    set((s) => patchStream(s, sessionId, (stream) => ({
      ...stream,
      items: stream.items.map((item) =>
        item.type === 'tool_use' && item.callId === callId
          ? { ...item, permissionPending: pending || undefined }
          : item,
      ),
    })));
  },

  markThinkingDone(sessionId, blockIndex) {
    set((s) => patchStream(s, sessionId, (stream) => {
      let thinkingIndex = 0;
      return {
        ...stream,
        thinkingActive: false,
        items: stream.items.map((item) => {
          if (item.type !== 'thinking') return item;
          const hit = thinkingIndex === blockIndex;
          thinkingIndex++;
          return hit ? { ...item, done: true } : item;
        }),
      };
    }));
  },

  narrativeRecallStarted(sessionId) {
    set((s) => patchStream(s, sessionId, (stream) => ({
      ...stream,
      items: [
        ...stream.items.filter((item) => item.type !== 'narrative_status'),
        {
          type: 'narrative_status',
          status: 'running',
          timelines: [],
          completedTimelines: [],
          snippets: {},
          failedTimelines: {},
        },
      ],
    })));
  },

  narrativeRecallCompleted(sessionId, event) {
    set((s) => patchStream(s, sessionId, (stream) => ({
      ...stream,
      items: [
        ...stream.items.filter((item) => item.type !== 'narrative_status'),
        {
          type: 'narrative_status',
          status: 'completed',
          timelines: [...event.timelineOrder],
          completedTimelines: event.timelines.map((timeline) => timeline.name),
          snippets: Object.fromEntries(
            event.timelines.map((timeline) => [timeline.name, timeline.snippet]),
          ),
          failedTimelines: Object.fromEntries(
            event.failures.map((failure) => [failure.timeline, failure.message]),
          ),
        },
      ],
    })));
  },

  narrativeRecallFailed(sessionId, message) {
    set((s) => patchStream(s, sessionId, (stream) => ({
      ...stream,
      items: [
        ...stream.items.filter((item) => item.type !== 'narrative_status'),
        {
          type: 'narrative_status',
          status: 'failed',
          timelines: [],
          completedTimelines: [],
          snippets: {},
          failedTimelines: {},
          message,
        },
      ],
    })));
  },

  setIteration(sessionId, iteration) {
    set((s) => patchStream(s, sessionId, (stream) => ({ ...stream, iteration })));
  },

  // ── 终态收口 ────────────────────────────────────────────────────────────

  settleStream(sessionId) {
    void (async () => {
      await get().reloadMessages(sessionId);
      set((s) => {
        const streamBySession = new Map(s.streamBySession);
        streamBySession.delete(sessionId);
        return { streamBySession };
      });
    })();
    useSessionHistory.getState().noteTailUpdate(sessionId);
    useSessionHistory.getState().invalidateTurnIndex(sessionId);
    // 标题由服务端在首个 Turn 完成后生成并经系统事件广播；这里只刷新列表。
    void useSessionStore.getState().loadSessions().catch(() => {});
  },

  abortStream(sessionId, reason) {
    // 中止时流态可能含未落库的展示内容；终态消息以重拉为准。
    void (async () => {
      await get().reloadMessages(sessionId);
      set((s) => {
        const streamBySession = new Map(s.streamBySession);
        streamBySession.delete(sessionId);
        return { streamBySession };
      });
    })();

    set((s) => {
      const stops = new Map(s.stopReasonBySession);
      stops.set(sessionId, reason);
      return { stopReasonBySession: stops };
    });
    setTimeout(() => {
      set((s) => {
        const stops = new Map(s.stopReasonBySession);
        stops.delete(sessionId);
        return { stopReasonBySession: stops };
      });
    }, 3000);

    useSessionHistory.getState().noteTailUpdate(sessionId);
    useSessionHistory.getState().invalidateTurnIndex(sessionId);
    if (reason !== '已停止') {
      void useSessionStore.getState().loadSessions().catch(() => {});
    }
  },

  evictSession(sessionId) {
    set((s) => {
      const messages = new Map(s.messages);
      messages.delete(sessionId);
      const turns = new Map(s.turns);
      turns.delete(sessionId);
      const loaded = new Set(s.loadedSessions);
      loaded.delete(sessionId);
      const streamBySession = new Map(s.streamBySession);
      streamBySession.delete(sessionId);
      const pending = new Map(s.pendingInputBySession);
      pending.delete(sessionId);
      const stops = new Map(s.stopReasonBySession);
      stops.delete(sessionId);
      return {
        messages,
        turns,
        loadedSessions: loaded,
        streamBySession,
        pendingInputBySession: pending,
        stopReasonBySession: stops,
      };
    });
  },
}));
