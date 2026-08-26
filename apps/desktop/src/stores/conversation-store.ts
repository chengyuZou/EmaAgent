// 管理各 Session 的会话状态、发送队列和 SSE 生命周期。
import {
  create }          from 'zustand';
import { createSendQueue,
  type SendQueue } from '../lib/send-queue.js';
import { createTurnAcceptance,
  type TurnAcceptance } from '../lib/turn-acceptance.js';
import { startTurnSseLifecycle } from '../lib/turn-sse-lifecycle.js';
import { sessionsApi } from '../api/sessions.js';
import {
  turnsApi,
  type TurnCreateInput,
  type TurnAttachmentInput,
  } from '../api/turns.js';
import {
  handleTurnAborted,
  evictSessionPlayers,
  } from '../lib/tts-playback.js';
import { useSessionStore }     from './session-store.js';
import { useAgentRunStore }    from './agentRunStore.js';
import { useSessionAttachmentStore } from './session-attachment-store.js';
import { useSessionHistoryStore } from '../chat/history/sessionHistoryStore.js';
import { useTaskStore } from './taskStore.js';
import {
  dispatchSseEvent,
  type StreamCallbacks,
  type DeltaSlice,
  type DeltaPayload,
  } from './conversation-sse.js';
import {
  assembleHistory,
  appendTextSlice,
  appendThinkingSlice,
  createOptimisticUserMessage,
  reconcileLoadedHistory,
  type AnyAssistantSlice,
  type ChatHistoryItem,
  type StreamingAssistantMessage,
  } from './conversation-history.js';

import type {
  ExecutionProfile,
  NarrativePolicy,
} from '@ema-agent/session';
import type {
  TurnCreatedResponse,
  TurnModelSelection,
  TurnStats,
} from '@ema-agent/turn';
import type { EmotionState } from '@ema-agent/stage';

// ── Re-export types that consumers import from this module ────────────────────

export type {
  AnyAssistantSlice as AssistantSlice,
} from './conversation-history.js';
export type {
  ChatHistoryItem,
  StreamingAssistantMessage,
} from './conversation-history.js';

const NARRATIVE_INTERRUPTED_MESSAGE = '剧情检索被中断，未产生完整结果';

/** Turn 已终止时，运行中的 Narrative 不能作为永久加载状态进入会话历史。 */
function settleInterruptedNarrativeSlices(
  slices: AnyAssistantSlice[],
): AnyAssistantSlice[] {
  let changed = false;
  const settled = slices.map((slice) => {
    if (slice.type !== 'narrative_status' || slice.status !== 'running') return slice;
    changed = true;
    return {
      ...slice,
      status: 'interrupted' as const,
      message: slice.message ?? NARRATIVE_INTERRUPTED_MESSAGE,
    };
  });
  return changed ? settled : slices;
}

// ── Send input ────────────────────────────────────────────────────────────────

interface SendInput {
  sessionId:     string;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  text?:         string;
  attachments?:  TurnAttachmentInput[];
  /** 显式选中的 Skill；以 skill part 随输入保序提交。 */
  skillKeys?:    string[];
  /** 本 Turn 的完整模型覆盖；缺省使用 Session 当前选择。 */
  modelSelection?: TurnModelSelection;
  /** 本 Turn 在当前激活知识库内的文档范围；缺省整个激活库。 */
  knowledgeAssetIds?: string[];
  ttsEnabled?:      boolean;
}

interface QueuedSendInput extends SendInput {
  acceptance: TurnAcceptance<TurnCreatedResponse>;
}

// ── Module-level per-session resources ────────────────────────────────────────

const sseHandles         = new Map<string, { stop(): void }>();
const sendQueues         = new Map<string, SendQueue<QueuedSendInput>>();

/** 组装保序 TurnInputPart：正文在前，附件与 Skill 引用按声明顺序随后。 */
function buildInputParts(input: SendInput): TurnCreateInput['input'] {
  const parts: TurnCreateInput['input'] = [];
  if (input.text && input.text.trim().length > 0) {
    parts.push({ type: 'text', text: input.text });
  }
  for (const attachment of input.attachments ?? []) {
    parts.push({ type: 'attachment', attachment });
  }
  for (const skillKey of input.skillKeys ?? []) {
    parts.push({ type: 'skill', skillKey });
  }
  return parts;
}

function getOrCreateQueue(sessionId: string): SendQueue<QueuedSendInput> {
  const key   = sessionId as string;
  const found = sendQueues.get(key);
  if (found) return found;

  const queue = createSendQueue<QueuedSendInput>({
    async handler(input) {
      const { turnId, sessionId: actualSessionId } = await turnsApi.create({
        sessionId:    input.sessionId as string,
        executionProfile: input.executionProfile,
        narrativePolicy: input.narrativePolicy,
        input:        buildInputParts(input),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.knowledgeAssetIds && input.knowledgeAssetIds.length > 0
          ? { knowledge: { assetIds: input.knowledgeAssetIds } }
          : {}),
        ...(input.ttsEnabled !== undefined ? { ttsEnabled: input.ttsEnabled } : {}),
      });
      input.acceptance.accept({ turnId, sessionId: actualSessionId });

      if ((actualSessionId as string) !== (input.sessionId as string)) {
        void useSessionStore.getState().loadSessions();
        useConversationStore.setState({ viewedSessionId: actualSessionId });
      }

      const callbacks: StreamCallbacks = {
        beginStream: (sid, tid, executionProfile, narrativePolicy) => useConversationStore
          .getState()
          .beginStream(sid, tid, executionProfile, narrativePolicy),
        appendDelta: (sid, slice, delta) => useConversationStore.getState().appendDelta(sid, slice, delta),
        finalizeStream: (sid, stats) => useConversationStore.getState().finalizeStream(sid, stats),
        abortStream: (sid, reason) => useConversationStore.getState().abortStream(sid, reason),
      };

      // Turn 生命周期统一持有当前连接和待重连计时器，用户停止时两者会一起取消。
      const lifecycle = startTurnSseLifecycle({
        openResponse: (signal, lastEventId) => turnsApi.openEvents(
          turnId,
          lastEventId,
          signal,
        ),
        onEvent(event) {
          const sid = ('sessionId' in event && event.sessionId)
            ? event.sessionId
            : input.sessionId;
          dispatchSseEvent(event, sid, callbacks);
        },
        onPermanentDisconnect(error) {
          console.error('[conversation-store] SSE failed permanently', error);
          useConversationStore.getState().abortStream(
            input.sessionId,
            `连接中断：${error.message}`,
          );
        },
      });
      sseHandles.set(input.sessionId as string, lifecycle);
      await lifecycle.done;

      if (sseHandles.get(input.sessionId as string) === lifecycle) {
        sseHandles.delete(input.sessionId as string);
      }
    },
    continueOnError: true,
  });

  sendQueues.set(key, queue);
  return queue;
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface ConversationStoreState {
  viewedSessionId:    string | null;
  ttsOwnerSessionId:  string | null;
  emotionStateMap:    Map<string, EmotionState>;
  iterationCountMap:  Map<string, number>;
  liveUsageMap:       Map<string, { inputTokens: number; outputTokens: number }>;
  thinkingActiveMap:  Map<string, boolean>;
  messages:           Map<string, ChatHistoryItem[]>;
  loadedMessageSessions: Set<string>;
  streamingMap:       Map<string, StreamingAssistantMessage>;
  stopReasonMap:      Map<string, string>;
  draftMap:           Map<string, string>;
  loading:            { messages: Set<string> };
  error:              string | null;
  scrollToTurnId:     string | null;

  viewSession(id: string):                                                Promise<void>;
  /** 新建会话前先复用空会话(F-051): viewed 会话还没有任何 turn 时直接复用, 不重复创建。 */
  createFreshSession():                                                      Promise<string | null>;
  scrollToTurn(turnId: string):                                              void;
  /** Turn 创建成功后 resolve；后续 SSE 生命周期由会话状态独立管理。 */
  sendMessage(sessionId: string | null, input: Omit<SendInput, 'sessionId'>): Promise<void>;
  stopStreaming(sessionId: string):                                        void;
  setDraft(sessionId: string, text: string):                              void;
  loadMessages(id: string):                                               Promise<void>;
  evictSession(id: string):                                               void;

  beginStream(
    sessionId: string,
    turnId: string,
    executionProfile?: ExecutionProfile,
    narrativePolicy?: NarrativePolicy,
  ): void;
  appendDelta(sessionId: string, slice: DeltaSlice, delta: DeltaPayload): void;
  finalizeStream(sessionId: string, stats: TurnStats | null):             void;
  abortStream(sessionId: string, reason: string):                         void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useConversationStore = create<ConversationStoreState>((set, get) => ({
  viewedSessionId:     null,
  ttsOwnerSessionId:   null,
  emotionStateMap:     new Map(),
  iterationCountMap:   new Map(),
  liveUsageMap:        new Map(),
  thinkingActiveMap:   new Map(),
  messages:            new Map(),
  loadedMessageSessions: new Set(),
  streamingMap:        new Map(),
  stopReasonMap:       new Map(),
  draftMap:            new Map(),
  loading:             { messages: new Set() },
  error:               null,
  scrollToTurnId:      null,

  scrollToTurn(turnId) { set({ scrollToTurnId: turnId }); },

  // ── Navigation ───────────────────────────────────────────────────────────

  async viewSession(id) {
    if (get().viewedSessionId === id) {
      await get().loadMessages(id);
      return;
    }
    set({ viewedSessionId: id });

    void sessionsApi.markViewed(id)
      .then(() => useSessionStore.getState().loadSessions())
      .catch(() => {});

    await get().loadMessages(id);
  },

  async createFreshSession() {
    const viewedId = get().viewedSessionId;
    if (viewedId) {
      const viewed = useSessionStore.getState().sessions.byId.get(viewedId as string);
      // 空会话(从未产生 turn)直接复用, 连点"新建会话"不再产生一串空会话。
      if (viewed && viewed.lastTurnStatus === null) return viewedId;
    }
    return useSessionStore.getState().createSession();
  },

  // ── Messages ─────────────────────────────────────────────────────────────

  async loadMessages(id) {
    if (get().loadedMessageSessions.has(id as string)) return;
    if (get().loading.messages.has(id as string)) return;

    set((s) => ({
      loading: { messages: new Set([...s.loading.messages, id as string]) },
    }));
    try {
      const { messages: raw, turns } = await sessionsApi.listMessages(id);
      const history = assembleHistory(raw, turns);

      set((s) => {
        const msgs    = new Map(s.messages);
        const cached = msgs.get(id as string) ?? [];
        msgs.set(id as string, reconcileLoadedHistory(history, cached));
        const loading = new Set(s.loading.messages);
        loading.delete(id as string);
        const loaded = new Set(s.loadedMessageSessions);
        loaded.add(id as string);
        return {
          messages: msgs,
          loading: { messages: loading },
          loadedMessageSessions: loaded,
        };
      });
    } catch (err: unknown) {
      set((s) => {
        const loading = new Set(s.loading.messages);
        loading.delete(id as string);
        return {
          error: err instanceof Error ? err.message : 'Failed to load messages',
          loading: { messages: loading },
        };
      });
    }
  },

  // ── Send ─────────────────────────────────────────────────────────────────

  async sendMessage(sessionId, input) {
    let targetId = sessionId;
    let createdNewSession = false;

    if (!targetId) {
      const newSession = await sessionsApi.create();
      targetId = newSession.id;
      createdNewSession = true;
      void useSessionStore.getState().loadSessions();
      set({ viewedSessionId: targetId });
    }
    useSessionHistoryStore.getState().showTail(targetId);

    const acceptance = createTurnAcceptance<TurnCreatedResponse>();
    const completion = getOrCreateQueue(targetId).enqueue({
      ...input,
      sessionId: targetId,
      acceptance,
    });
    void completion.catch((err: unknown) => acceptance.reject(err));
    const accepted = await acceptance.promise;
    const acceptedSessionId = accepted.sessionId;

    // 附件在 POST /turns 返回前已经持久化；面板若已加载，立即刷新当前 Session，
    // 未打开过的会话不额外发请求，首次打开时再按需加载。
    if (input.attachments?.length
      && useSessionAttachmentStore.getState().bySession.has(acceptedSessionId as string)) {
      void useSessionAttachmentStore.getState()
        .loadForSession(acceptedSessionId, true)
        .catch(() => {});
    }

    set((s) => {
      const key = acceptedSessionId as string;
      const msgs = new Map(s.messages);
      const existing = msgs.get(key) ?? [];
      const alreadyPresent = existing.some(
        (message) => message.role === 'user' && message.turnId === accepted.turnId,
      );
      if (!alreadyPresent) {
        msgs.set(key, [
          ...existing,
          createOptimisticUserMessage(
            accepted.turnId,
            input.text ?? '',
          ),
        ]);
      }
      const loaded = new Set(s.loadedMessageSessions);
      if (createdNewSession) loaded.add(key);
      return { messages: msgs, loadedMessageSessions: loaded };
    });
    useSessionHistoryStore.getState().invalidateTurnIndex(acceptedSessionId);
  },

  stopStreaming(sessionId) {
    // 停止是 Session 级操作：只断开 SSE 不会停止后端执行；界面立即收口，
    // 同时并行发送 Session 级中止信号（Turn 与 compact 共用同一活跃坑位）。
    void sessionsApi.abort(sessionId).catch(() => {});
    sseHandles.get(sessionId as string)?.stop();
    sseHandles.delete(sessionId as string);
    handleTurnAborted(sessionId as string);
    get().abortStream(sessionId, '已停止');
  },

  setDraft(sessionId, text) {
    set((s) => {
      const drafts = new Map(s.draftMap);
      if (text) { drafts.set(sessionId as string, text); } else { drafts.delete(sessionId as string); }
      return { draftMap: drafts };
    });
  },

  evictSession(id) {
    sseHandles.get(id as string)?.stop();
    sseHandles.delete(id as string);
    sendQueues.get(id as string)?.clear();
    sendQueues.delete(id as string);
    evictSessionPlayers(id as string);
    useAgentRunStore.getState().evictSession(id as string);
    useSessionAttachmentStore.getState().evictSession(id);
    useSessionHistoryStore.getState().evictSession(id);
    useTaskStore.getState().evictSession(id);

    set((s) => {
      const msgs      = new Map(s.messages);       msgs.delete(id as string);
      const loaded    = new Set(s.loadedMessageSessions); loaded.delete(id as string);
      const streaming = new Map(s.streamingMap);   streaming.delete(id as string);
      const stops     = new Map(s.stopReasonMap);  stops.delete(id as string);
      const drafts    = new Map(s.draftMap);       drafts.delete(id as string);
      const emotions  = new Map(s.emotionStateMap); emotions.delete(id as string);
      const iters     = new Map(s.iterationCountMap); iters.delete(id as string);
      const lastTurnId = s.streamingMap.get(id as string)?.turnId as string | undefined;
      const usageMap   = new Map(s.liveUsageMap);
      const thinking   = new Map(s.thinkingActiveMap);
      if (lastTurnId) { usageMap.delete(lastTurnId); thinking.delete(lastTurnId); }

      return {
        messages: msgs, loadedMessageSessions: loaded,
        streamingMap: streaming, stopReasonMap: stops, draftMap: drafts,
        emotionStateMap: emotions, iterationCountMap: iters,
        liveUsageMap: usageMap, thinkingActiveMap: thinking,
      };
    });
  },

  // ── Stream lifecycle ─────────────────────────────────────────────────────

  beginStream(sessionId, turnId, executionProfile = 'chat', narrativePolicy = 'auto') {
    set((s) => {
      const streaming = new Map(s.streamingMap);
      streaming.set(sessionId as string, {
        role: 'assistant', content: '', slices: [], startedAt: Date.now(), turnId,
        executionProfile, narrativePolicy,
      });
      const stops    = new Map(s.stopReasonMap); stops.delete(sessionId as string);
      const iters    = new Map(s.iterationCountMap); iters.delete(sessionId as string);
      return { streamingMap: streaming, stopReasonMap: stops, iterationCountMap: iters };
    });
  },

  appendDelta(sessionId, slice, delta) {
    set((s) => {
      const sm = s.streamingMap.get(sessionId as string);
      if (!sm) return {};

      if (slice === 'text' && typeof delta === 'string') {
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, {
          ...sm, content: sm.content + delta,
          slices: appendTextSlice(sm.slices, delta),
        });
        return { streamingMap: streaming };
      }

      if (slice === 'thinking' && typeof delta === 'string') {
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, {
          ...sm, slices: appendThinkingSlice(sm.slices, delta),
        });
        return { streamingMap: streaming };
      }

      if (slice === 'tool_use' && typeof delta === 'object') {
        const tc  = delta as { callId: string; name: string; args: unknown };
        const idx = sm.slices.findIndex((sl) => sl.type === 'tool_use' && sl.callId === tc.callId);
        const newSlices = idx >= 0
          ? sm.slices.map((sl, i) => {
              if (i !== idx) return sl;
              const tsl = sl as Extract<AnyAssistantSlice, { type: 'tool_use' }>;
              return { ...tsl, args: tc.args, partialArgs: undefined };
            })
          : [...sm.slices, { type: 'tool_use' as const, callId: tc.callId, name: tc.name, args: tc.args, startedAt: Date.now() }];
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices: newSlices });
        return { streamingMap: streaming };
      }

      if (slice === 'tool_result' && typeof delta === 'object') {
        const tr = delta as { callId: string; output?: unknown; error?: { code: string; message: string }; durationMs?: number };
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, {
          ...sm,
          slices: sm.slices.map((sl) =>
            sl.type === 'tool_use' && sl.callId === tr.callId
              ? { ...sl, result: tr.output ?? null, error: tr.error, durationMs: tr.durationMs, errorCode: tr.error?.code, permissionPending: undefined }
              : sl,
          ),
        });
        return { streamingMap: streaming };
      }

      return {};
    });
  },

  finalizeStream(sessionId, stats) {
    set((s) => {
      const sm        = s.streamingMap.get(sessionId as string);
      const streaming = new Map(s.streamingMap);
      streaming.delete(sessionId as string);

      if (!sm) return { streamingMap: streaming };

      const historyItem = {
        role: 'assistant' as const,
        content: sm.content,
        slices: settleInterruptedNarrativeSlices(sm.slices),
        createdAt: Date.now(), stats: stats ?? undefined, turnId: sm.turnId,
        executionProfile: sm.executionProfile,
        narrativePolicy: sm.narrativePolicy,
      };
      const msgs     = new Map(s.messages);
      const existing = msgs.get(sessionId as string) ?? [];
      msgs.set(sessionId as string, [...existing, historyItem]);

      return { messages: msgs, streamingMap: streaming };
    });

    useSessionHistoryStore.getState().noteTailUpdate(sessionId);
    useSessionHistoryStore.getState().invalidateTurnIndex(sessionId);

    // 标题由服务端在首个 Turn 完成后自动生成并经系统事件广播；这里只刷新列表。
    void useSessionStore.getState().loadSessions().catch(() => {});
  },

  abortStream(sessionId, reason) {
    const partialWasVisible = (() => {
      const stream = get().streamingMap.get(sessionId as string);
      return Boolean(stream && (stream.content.trim() || stream.slices.length > 0));
    })();
    set((s) => {
      const sm        = s.streamingMap.get(sessionId as string);
      const streaming = new Map(s.streamingMap);
      streaming.delete(sessionId as string);
      const stops = new Map(s.stopReasonMap);
      stops.set(sessionId as string, reason);

      if (sm && (sm.content.trim() || sm.slices.length > 0)) {
        const partial = {
          role: 'assistant' as const,
          content: sm.content,
          slices: settleInterruptedNarrativeSlices(sm.slices),
          createdAt: sm.startedAt, turnId: sm.turnId,
          executionProfile: sm.executionProfile,
          narrativePolicy: sm.narrativePolicy,
        };
        const msgs     = new Map(s.messages);
        const existing = msgs.get(sessionId as string) ?? [];
        msgs.set(sessionId as string, [...existing, partial]);
        return { messages: msgs, streamingMap: streaming, stopReasonMap: stops };
      }

      return { streamingMap: streaming, stopReasonMap: stops };
    });

    if (partialWasVisible) useSessionHistoryStore.getState().noteTailUpdate(sessionId);
    useSessionHistoryStore.getState().invalidateTurnIndex(sessionId);

    setTimeout(() => {
      set((s) => {
        const stops = new Map(s.stopReasonMap);
        stops.delete(sessionId as string);
        return { stopReasonMap: stops };
      });
    }, 3000);

    if (reason !== '已停止') {
      void useSessionStore.getState().loadSessions().catch(() => {});
    }
  },
}));
