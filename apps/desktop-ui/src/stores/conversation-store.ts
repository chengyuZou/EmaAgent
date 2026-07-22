// 管理各 Session 的会话状态、发送队列和 SSE 生命周期。
/**
 * conversation-store.ts — Zustand store for conversation state + SSE queue.
 *
 * Responsibilities here (by design, kept minimal):
 *   - Per-session SSE connection lifecycle (sseHandles, sendQueues)
 *   - Zustand state + simple CRUD actions (beginStream, appendDelta, …)
 *   - sendMessage / stopStreaming (the public API for UI components)
 *
 * Heavy logic lives in sibling files:
 *   - conversation-history.ts: pure data helpers (assembleHistory, helpers)
 *   - conversation-sse.ts:     SSE event dispatch + Tauri relay
 */
import {
  create }          from 'zustand';
import { createSendQueue,
  type SendQueue } from '../lib/send-queue.js';
import { createTurnAcceptance,
  type TurnAcceptance } from '../lib/turn-acceptance.js';
import { startTurnSseLifecycle } from '../lib/turn-sse-lifecycle.js';
import { sessionsApi,
  type BranchTreeWire } from '../api/sessions.js';
import {
  turnsApi,
  type AttachmentInputWire,
  } from '../api/turns.js';
import type { KbAssetScope, ToolPresentation } from '@ema-agent/turn';
import {
  handleTurnAborted,
  evictSessionPlayers,
  } from '../lib/tts-playback.js';
import { useSessionStore }     from './session-store.js';
import { useArtifactStore }    from './artifact-store.js';
import { useAgentTaskStore }   from './agent-task-store.js';
import { useSessionAttachmentStore } from './session-attachment-store.js';
import {
  dispatchSseEvent,
  breakerReasons,
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
  SessionId,
  TurnId,
  BranchId,
} from '@ema-agent/ids';
import {
  type ExecutionProfile,
  type TurnContentPart as MessageContentPart,
  type NarrativePolicy,
  type TurnCreatedResponse,
} from '@ema-agent/turn';
import {
  TurnStats,
  MemoryRecallLayer,
  MemoryRecallLayerReport,
} from '@ema-agent/turn';
import type { EmotionState } from '@ema-agent/emotion';

export type { AttachmentInputWire };

export type BranchLoadState =
  | { status: 'idle'; error: null }
  | { status: 'loading'; error: null }
  | { status: 'ready'; error: null; updatedAt: number }
  | { status: 'stale'; error: string; updatedAt: number }
  | { status: 'error'; error: string };

// ── Re-export types that consumers import from this module ────────────────────

export type {
  AnyAssistantSlice as AssistantSlice,
} from './conversation-history.js';
export type {
  ChatHistoryItem,
  StreamingAssistantMessage,
} from './conversation-history.js';

// ── Send input ────────────────────────────────────────────────────────────────

interface SendInput {
  sessionId:     SessionId;
  executionProfile: ExecutionProfile;
  narrativePolicy: NarrativePolicy;
  text?:         string;
  contentParts?: MessageContentPart[];
  attachments?:  AttachmentInputWire[];
  providerId?:   string;
  model?:          string;
  ttsEnabled?:      boolean;
  thinkingEnabled?: boolean;
  kbIds?:          string[];
  kbAssetScopes?:  KbAssetScope[];
}

interface QueuedSendInput extends SendInput {
  acceptance: TurnAcceptance<TurnCreatedResponse>;
}

// ── Module-level per-session resources ────────────────────────────────────────

const sseHandles         = new Map<string, { stop(): void }>();
const sendQueues         = new Map<string, SendQueue<QueuedSendInput>>();
const pendingTitleSessions = new Set<string>();

function getOrCreateQueue(sessionId: SessionId): SendQueue<QueuedSendInput> {
  const key   = sessionId as string;
  const found = sendQueues.get(key);
  if (found) return found;

  const queue = createSendQueue<QueuedSendInput>({
    async handler(input) {
      const { turnId, sessionId: actualSessionId } = await turnsApi.create({
        sessionId:    input.sessionId as string,
        trigger:      { type: 'userMessage' },
        executionProfile: input.executionProfile,
        narrativePolicy: input.narrativePolicy,
        userInput:    input.text,
        contentParts: input.contentParts,
        attachments:  input.attachments,
        providerId:   input.providerId,
        model:          input.model,
        ttsEnabled:      input.ttsEnabled,
        thinkingEnabled: input.thinkingEnabled,
        kbIds:          input.kbIds,
        kbAssetScopes:  input.kbAssetScopes,
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
            ? event.sessionId as SessionId
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
  viewedSessionId:    SessionId | null;
  ttsOwnerSessionId:  SessionId | null;
  emotionStateMap:    Map<string, EmotionState>;
  iterationCountMap:  Map<string, number>;
  recallEvidenceMap:  Map<string, Partial<Record<MemoryRecallLayer, MemoryRecallLayerReport>>>;
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
  branchDataBySession: Map<string, BranchTreeWire>;
  branchLoadStateBySession: Map<string, BranchLoadState>;
  /** 已标记的分叉点: 点击 ForkButton 只记录, 发送消息时才真正创建分支(F-052)。 */
  pendingForkFromTurnId: TurnId | null;

  viewSession(id: SessionId):                                                Promise<void>;
  /** 新建会话前先复用空会话(F-051): viewed 会话还没有任何 turn 时直接复用, 不重复创建。 */
  createFreshSession():                                                      Promise<SessionId | null>;
  armFork(turnId: TurnId):                                                   void;
  clearPendingFork():                                                        void;
  scrollToTurn(turnId: string):                                              void;
  loadBranches(id: SessionId):                                               Promise<void>;
  /** 切换分支并重载 —— BranchPanel 节点点击 + BranchSiblingNav 切换统一走这里，保证双向联动。 */
  switchBranchAndLoad(sessionId: SessionId, branchId: BranchId | null):      Promise<void>;
  /** Turn 创建成功后 resolve；后续 SSE 生命周期由会话状态独立管理。 */
  sendMessage(sessionId: SessionId | null, input: Omit<SendInput, 'sessionId'>): Promise<void>;
  stopStreaming(sessionId: SessionId):                                        void;
  setDraft(sessionId: SessionId, text: string):                              void;
  loadMessages(id: SessionId):                                               Promise<void>;
  evictSession(id: SessionId):                                               void;

  beginStream(
    sessionId: SessionId,
    turnId: TurnId,
    executionProfile?: ExecutionProfile,
    narrativePolicy?: NarrativePolicy,
  ): void;
  appendDelta(sessionId: SessionId, slice: DeltaSlice, delta: DeltaPayload): void;
  finalizeStream(sessionId: SessionId, stats: TurnStats | null):             void;
  abortStream(sessionId: SessionId, reason: string):                         void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useConversationStore = create<ConversationStoreState>((set, get) => ({
  viewedSessionId:     null,
  ttsOwnerSessionId:   null,
  emotionStateMap:     new Map(),
  iterationCountMap:   new Map(),
  recallEvidenceMap:   new Map(),
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
  branchDataBySession: new Map(),
  branchLoadStateBySession: new Map(),
  pendingForkFromTurnId: null,

  scrollToTurn(turnId) { set({ scrollToTurnId: turnId }); },
  armFork(turnId)      { set({ pendingForkFromTurnId: turnId }); },
  clearPendingFork()   { set({ pendingForkFromTurnId: null }); },

  async loadBranches(id) {
    const key = id as string;
    set((state) => {
      const states = new Map(state.branchLoadStateBySession);
      states.set(key, { status: 'loading', error: null });
      return { branchLoadStateBySession: states };
    });
    try {
      const data = await sessionsApi.listBranches(id);
      set((s) => {
        const m = new Map(s.branchDataBySession);
        m.set(key, data);
        const states = new Map(s.branchLoadStateBySession);
        states.set(key, { status: 'ready', error: null, updatedAt: Date.now() });
        return { branchDataBySession: m, branchLoadStateBySession: states };
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '加载分支失败';
      set((state) => {
        const states = new Map(state.branchLoadStateBySession);
        const previous = states.get(key);
        states.set(key, state.branchDataBySession.has(key)
          ? {
              status: 'stale',
              error: message,
              updatedAt: previous && 'updatedAt' in previous ? previous.updatedAt : Date.now(),
            }
          : { status: 'error', error: message });
        return { branchLoadStateBySession: states };
      });
      throw error;
    }
  },

  // 统一分支切换动作：BranchPanel 节点点击 + BranchSiblingNav ‹› 都走这里。
  // 调 loadBranches 更新 branchDataBySession（两边都订阅，双向联动）+ 清 messages 重载。
  async switchBranchAndLoad(sessionId, branchId) {
    await sessionsApi.switchBranch(sessionId, branchId);
    await get().loadBranches(sessionId);
    await useSessionStore.getState().loadSessions();
    // Evict + reload messages so the switched branch history appears.
    set((s) => {
      const m = new Map(s.messages);
      m.delete(sessionId as string);
      const loaded = new Set(s.loadedMessageSessions);
      loaded.delete(sessionId as string);
      return { messages: m, loadedMessageSessions: loaded };
    });
    await get().loadMessages(sessionId);
  },

  // ── Navigation ───────────────────────────────────────────────────────────

  async viewSession(id) {
    if (get().viewedSessionId === id) {
      await get().loadMessages(id);
      return;
    }
    set({ viewedSessionId: id, pendingForkFromTurnId: null });

    void sessionsApi.markViewed(id)
      .then(() => useSessionStore.getState().loadSessions())
      .catch(() => {});

    await get().loadMessages(id);
    // 分支树属于辅助数据；失败状态已写入 Store，导航主流程仍可展示消息。
    void get().loadBranches(id).catch(() => {});
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
      targetId = newSession.id as SessionId;
      createdNewSession = true;
      void useSessionStore.getState().loadSessions();
      set({ viewedSessionId: targetId });
    }

    // F-052: 分叉延迟创建——点击只标记分叉点, 发送时才真正创建分支并切换;
    // 创建失败则中止发送, 不把消息落到旧分支上。
    const pendingFork = get().pendingForkFromTurnId;
    if (pendingFork) {
      set({ pendingForkFromTurnId: null });
      try {
        await sessionsApi.forkBranch(targetId, pendingFork);
        await get().loadBranches(targetId);
        useConversationStore.setState((s) => {
          const m = new Map(s.messages);
          m.delete(targetId as string);
          const loaded = new Set(s.loadedMessageSessions);
          loaded.delete(targetId as string);
          return { messages: m, loadedMessageSessions: loaded };
        });
        await get().loadMessages(targetId);
      } catch (err) {
        throw new Error(
          err instanceof Error ? `分叉失败: ${err.message}` : '分叉失败',
          { cause: err },
        );
      }
    }

    const acceptance = createTurnAcceptance<TurnCreatedResponse>();
    const completion = getOrCreateQueue(targetId).enqueue({
      ...input,
      sessionId: targetId,
      acceptance,
    });
    void completion.catch((err: unknown) => acceptance.reject(err));
    const accepted = await acceptance.promise;
    const acceptedSessionId = accepted.sessionId as SessionId;

    // 附件在 POST /turns 返回前已经持久化；面板若已加载，立即刷新当前 Session，
    // 未打开过的会话不额外发请求，首次打开时再按需加载。
    if (input.attachments?.length
      && useSessionAttachmentStore.getState().bySession.has(acceptedSessionId as string)) {
      void useSessionAttachmentStore.getState()
        .loadForSession(acceptedSessionId, true)
        .catch(() => {});
    }

    // Queue auto-title generation for a session's first completed assistant
    // turn. Covers both paths: lazy create (no targetId above) and pre-created
    // sessions (new-session button → createSession + viewSession). The set is
    // consumed in finalizeStream; checking "no assistant message yet" means a
    // session that already has replies won't re-trigger.
    const existingMsgs = get().messages.get(acceptedSessionId as string) ?? [];
    const hasAssistant = existingMsgs.some((m) => m.role === 'assistant');
    if (!hasAssistant) {
      pendingTitleSessions.add(acceptedSessionId as string);
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
            input.attachments,
          ),
        ]);
      }
      const loaded = new Set(s.loadedMessageSessions);
      if (createdNewSession) loaded.add(key);
      return { messages: msgs, loadedMessageSessions: loaded };
    });
  },

  stopStreaming(sessionId) {
    // Tell the backend to abort the turn too — disconnecting SSE alone leaves
    // the LLM stream + tools running server-side (burning tokens, executing
    // commands) after the UI already shows "stopped". Fire-and-forget: the UI
    // must react instantly, the abort signal reaches the backend in parallel.
    const turnId = get().streamingMap.get(sessionId as string)?.turnId;
    if (turnId) void turnsApi.abortTurn(turnId as string).catch(() => {});
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
    breakerReasons.delete(id as string);
    evictSessionPlayers(id as string);
    useArtifactStore.getState().evictSession(id);
    useAgentTaskStore.getState().evictSession(id as string);
    useSessionAttachmentStore.getState().evictSession(id);

    set((s) => {
      const msgs      = new Map(s.messages);       msgs.delete(id as string);
      const loaded    = new Set(s.loadedMessageSessions); loaded.delete(id as string);
      const streaming = new Map(s.streamingMap);   streaming.delete(id as string);
      const stops     = new Map(s.stopReasonMap);  stops.delete(id as string);
      const drafts    = new Map(s.draftMap);       drafts.delete(id as string);
      const emotions  = new Map(s.emotionStateMap); emotions.delete(id as string);
      const iters     = new Map(s.iterationCountMap); iters.delete(id as string);
      const recalls   = new Map(s.recallEvidenceMap); recalls.delete(id as string);
      const branchData = new Map(s.branchDataBySession); branchData.delete(id as string);
      const branchStates = new Map(s.branchLoadStateBySession); branchStates.delete(id as string);

      const lastTurnId = s.streamingMap.get(id as string)?.turnId as string | undefined;
      const usageMap   = new Map(s.liveUsageMap);
      const thinking   = new Map(s.thinkingActiveMap);
      if (lastTurnId) { usageMap.delete(lastTurnId); thinking.delete(lastTurnId); }

      return {
        messages: msgs, loadedMessageSessions: loaded,
        streamingMap: streaming, stopReasonMap: stops, draftMap: drafts,
        emotionStateMap: emotions, iterationCountMap: iters, recallEvidenceMap: recalls,
        liveUsageMap: usageMap, thinkingActiveMap: thinking,
        branchDataBySession: branchData,
        branchLoadStateBySession: branchStates,
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
      const recalls  = new Map(s.recallEvidenceMap); recalls.delete(sessionId as string);
      return { streamingMap: streaming, stopReasonMap: stops, iterationCountMap: iters, recallEvidenceMap: recalls };
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
        const tr = delta as { callId: string; output?: unknown; presentation?: ToolPresentation; error?: { code: string; message: string }; durationMs?: number };
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, {
          ...sm,
          slices: sm.slices.map((sl) =>
            sl.type === 'tool_use' && sl.callId === tr.callId
              ? { ...sl, result: tr.output ?? null, presentation: tr.presentation, error: tr.error, durationMs: tr.durationMs, errorCode: tr.error?.code, permissionPromptId: undefined }
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
        role: 'assistant' as const, content: sm.content, slices: sm.slices,
        createdAt: Date.now(), stats: stats ?? undefined, turnId: sm.turnId,
        executionProfile: sm.executionProfile,
        narrativePolicy: sm.narrativePolicy,
      };
      const msgs     = new Map(s.messages);
      const existing = msgs.get(sessionId as string) ?? [];
      msgs.set(sessionId as string, [...existing, historyItem]);

      return { messages: msgs, streamingMap: streaming };
    });

    // Turn 结束后重新读取权威列表，兜住丢失或乱序的 Artifact SSE 事件。
    useArtifactStore.getState().invalidateSession(sessionId);

    if (pendingTitleSessions.has(sessionId as string)) {
      pendingTitleSessions.delete(sessionId as string);
      void sessionsApi.generateTitle(sessionId)
        .then(() => useSessionStore.getState().loadSessions())
        .catch(() => {});
    } else {
      void useSessionStore.getState().loadSessions().catch(() => {});
    }
  },

  abortStream(sessionId, reason) {
    set((s) => {
      const sm        = s.streamingMap.get(sessionId as string);
      const streaming = new Map(s.streamingMap);
      streaming.delete(sessionId as string);
      const stops = new Map(s.stopReasonMap);
      stops.set(sessionId as string, reason);

      if (sm && (sm.content.trim() || sm.slices.length > 0)) {
        const partial = {
          role: 'assistant' as const, content: sm.content, slices: sm.slices,
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

    // 中止前工具仍可能已经落盘 Artifact，不能沿用本轮开始前的缓存。
    useArtifactStore.getState().invalidateSession(sessionId);

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
