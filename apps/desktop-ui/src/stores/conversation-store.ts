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
import { create }          from 'zustand';
import { createSendQueue, type SendQueue } from '../lib/send-queue.js';
import { sseConsumer }     from '../lib/sse-consumer.js';
import { sessionsApi, type BranchTreeWire } from '../api/sessions.js';
import { turnsApi, type AttachmentInputWire } from '../api/turns.js';
import { sidecarClient }   from '../api/sidecar-client.js';
import {
  handleTurnAborted,
  evictSessionPlayers,
} from '../lib/tts-playback.js';
import { useSessionStore }     from './session-store.js';
import { useArtifactStore }    from './artifact-store.js';
import { useAgentTaskStore }   from './agent-task-store.js';
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
  type AnyAssistantSlice,
} from './conversation-history.js';
import type {
  SessionId,
  TurnId,
  TurnMode,
  TurnStats,
  EmotionState,
  MemoryRecallLayer,
  MemoryRecallLayerReport,
  MessageContentPart,
} from '@ema-agent/contracts';

export type { AttachmentInputWire };

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
  mode:          TurnMode;
  text?:         string;
  contentParts?: MessageContentPart[];
  attachments?:  AttachmentInputWire[];
  providerId?:   string;
  model?:        string;
  ttsEnabled?:   boolean;
}

// ── Module-level per-session resources ────────────────────────────────────────

const sseHandles         = new Map<string, { stop(): void }>();
const sendQueues         = new Map<string, SendQueue<SendInput>>();
const pendingTitleSessions = new Set<string>();

function getOrCreateQueue(sessionId: SessionId): SendQueue<SendInput> {
  const key   = sessionId as string;
  const found = sendQueues.get(key);
  if (found) return found;

  const queue = createSendQueue<SendInput>({
    async handler(input) {
      const { turnId, sessionId: actualSessionId } = await turnsApi.create({
        sessionId:    input.sessionId as string,
        mode:         input.mode,
        userInput:    input.text,
        contentParts: input.contentParts,
        attachments:  input.attachments,
        providerId:   input.providerId,
        model:        input.model,
        ttsEnabled:   input.ttsEnabled,
      });

      if ((actualSessionId as string) !== (input.sessionId as string)) {
        void useSessionStore.getState().loadSessions();
        useConversationStore.setState({ viewedSessionId: actualSessionId });
      }

      const [url, authHeaders] = await Promise.all([
        turnsApi.eventsUrl(turnId),
        sidecarClient.getAuthHeaders(),
      ]);

      // SSE with reconnect — backend buffers events, replay on reconnect.
      const MAX_SSE_RETRIES = 3;
      await new Promise<void>((resolve) => {
        let cursor   = 0;
        let finished = false;

        const finish = (): void => { if (finished) return; finished = true; resolve(); };

        const startSse = (attempt: number): void => {
          if (finished) return;

          const cb: StreamCallbacks = {
            beginStream:    (sid, tid, mode) => useConversationStore.getState().beginStream(sid, tid, mode),
            appendDelta:    (sid, slice, delta) => useConversationStore.getState().appendDelta(sid, slice, delta),
            finalizeStream: (sid, stats) => { useConversationStore.getState().finalizeStream(sid, stats); finish(); },
            abortStream:    (sid, reason) => { useConversationStore.getState().abortStream(sid, reason); finish(); },
          };

          const handle = sseConsumer.start({
            url,
            headers:     authHeaders,
            lastEventId: cursor,
            onEvent: (event) => {
              cursor += 1;
              const sid = ('sessionId' in event && event.sessionId)
                ? event.sessionId as SessionId
                : input.sessionId;
              dispatchSseEvent(event, sid, cb);
            },
            onHeartbeat: () => {},
            onError: (err) => {
              if (!finished && attempt < MAX_SSE_RETRIES) {
                const delay = 1000 * 2 ** attempt;
                console.warn(`[conversation-store] SSE dropped, retry ${attempt + 1}/${MAX_SSE_RETRIES} in ${delay}ms:`, err.message);
                setTimeout(() => {
                  const stillStreaming = useConversationStore.getState()
                    .streamingMap.has(input.sessionId as string);
                  if (cursor > 0 && !stillStreaming) { finish(); return; }
                  startSse(attempt + 1);
                }, delay);
                return;
              }
              console.error('[conversation-store] SSE failed permanently', err);
              useConversationStore.getState().abortStream(input.sessionId, `连接中断：${err.message}`);
              finish();
            },
            onComplete: () => finish(),
          });
          sseHandles.set(input.sessionId as string, handle);
        };

        startSse(0);
      });

      sseHandles.delete(input.sessionId as string);
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
  messages:           Map<string, import('./conversation-history.js').ChatHistoryItem[]>;
  streamingMap:       Map<string, import('./conversation-history.js').StreamingAssistantMessage>;
  stopReasonMap:      Map<string, string>;
  draftMap:           Map<string, string>;
  loading:            { messages: Set<string> };
  error:              string | null;
  scrollToTurnId:     string | null;
  branchDataBySession: Map<string, BranchTreeWire>;

  viewSession(id: SessionId):                                                Promise<void>;
  scrollToTurn(turnId: string):                                              void;
  loadBranches(id: SessionId):                                               Promise<void>;
  sendMessage(sessionId: SessionId | null, input: Omit<SendInput, 'sessionId'>): Promise<void>;
  stopStreaming(sessionId: SessionId):                                        void;
  setDraft(sessionId: SessionId, text: string):                              void;
  loadMessages(id: SessionId):                                               Promise<void>;
  evictSession(id: SessionId):                                               void;

  beginStream(sessionId: SessionId, turnId: TurnId, mode?: TurnMode):        void;
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
  streamingMap:        new Map(),
  stopReasonMap:       new Map(),
  draftMap:            new Map(),
  loading:             { messages: new Set() },
  error:               null,
  scrollToTurnId:      null,
  branchDataBySession: new Map(),

  scrollToTurn(turnId) { set({ scrollToTurnId: turnId }); },

  async loadBranches(id) {
    try {
      const data = await sessionsApi.listBranches(id);
      set((s) => {
        const m = new Map(s.branchDataBySession);
        m.set(id as string, data);
        return { branchDataBySession: m };
      });
    } catch { /* non-critical */ }
  },

  // ── Navigation ───────────────────────────────────────────────────────────

  async viewSession(id) {
    if (get().viewedSessionId === id) return;
    set({ viewedSessionId: id });

    void sessionsApi.markViewed(id)
      .then(() => useSessionStore.getState().loadSessions())
      .catch(() => {});

    const session = useSessionStore.getState().sessions.byId.get(id as string);
    if (session?.lastMode) {
      useSessionStore.setState((s) => ({
        sessionModes: new Map(s.sessionModes).set(id as string, { mode: session.lastMode! }),
      }));
    }

    await get().loadMessages(id);
    void get().loadBranches(id);
  },

  // ── Messages ─────────────────────────────────────────────────────────────

  async loadMessages(id) {
    if (get().messages.has(id as string)) return;

    set((s) => ({
      loading: { messages: new Set([...s.loading.messages, id as string]) },
    }));
    try {
      const { messages: raw, turns } = await sessionsApi.listMessages(id);
      const history = assembleHistory(raw, turns);

      set((s) => {
        const msgs    = new Map(s.messages);
        msgs.set(id as string, history);
        const loading = new Set(s.loading.messages);
        loading.delete(id as string);
        return { messages: msgs, loading: { messages: loading } };
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

    if (!targetId) {
      const newSession = await sessionsApi.create();
      targetId = newSession.id as SessionId;
      pendingTitleSessions.add(targetId as string);
      void useSessionStore.getState().loadSessions();
      set({ viewedSessionId: targetId });
    }

    if (input.text && get().messages.has(targetId as string)) {
      set((s) => {
        const msgs     = new Map(s.messages);
        const existing = msgs.get(targetId as string) ?? [];
        msgs.set(targetId as string, [
          ...existing,
          { role: 'user' as const, content: input.text!, createdAt: Date.now() },
        ]);
        return { messages: msgs };
      });
    }

    set((s) => {
      const drafts = new Map(s.draftMap);
      drafts.delete(targetId as string);
      return { draftMap: drafts };
    });

    await getOrCreateQueue(targetId).enqueue({ ...input, sessionId: targetId });
  },

  stopStreaming(sessionId) {
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

    set((s) => {
      const msgs      = new Map(s.messages);       msgs.delete(id as string);
      const streaming = new Map(s.streamingMap);   streaming.delete(id as string);
      const stops     = new Map(s.stopReasonMap);  stops.delete(id as string);
      const drafts    = new Map(s.draftMap);       drafts.delete(id as string);
      const emotions  = new Map(s.emotionStateMap); emotions.delete(id as string);
      const iters     = new Map(s.iterationCountMap); iters.delete(id as string);
      const recalls   = new Map(s.recallEvidenceMap); recalls.delete(id as string);

      const lastTurnId = s.streamingMap.get(id as string)?.turnId as string | undefined;
      const usageMap   = new Map(s.liveUsageMap);
      const thinking   = new Map(s.thinkingActiveMap);
      if (lastTurnId) { usageMap.delete(lastTurnId); thinking.delete(lastTurnId); }

      return {
        messages: msgs, streamingMap: streaming, stopReasonMap: stops, draftMap: drafts,
        emotionStateMap: emotions, iterationCountMap: iters, recallEvidenceMap: recalls,
        liveUsageMap: usageMap, thinkingActiveMap: thinking,
      };
    });
  },

  // ── Stream lifecycle ─────────────────────────────────────────────────────

  beginStream(sessionId, turnId, mode) {
    set((s) => {
      const streaming = new Map(s.streamingMap);
      streaming.set(sessionId as string, {
        role: 'assistant', content: '', slices: [], startedAt: Date.now(), turnId, mode,
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
          : [...sm.slices, { type: 'tool_use' as const, callId: tc.callId, name: tc.name, args: tc.args }];
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices: newSlices });
        return { streamingMap: streaming };
      }

      if (slice === 'tool_result' && typeof delta === 'object') {
        const tr = delta as { callId: string; output?: unknown; error?: { code: string; message: string } };
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, {
          ...sm,
          slices: sm.slices.map((sl) =>
            sl.type === 'tool_use' && sl.callId === tr.callId
              ? { ...sl, result: tr.output ?? null, error: tr.error }
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
        createdAt: Date.now(), stats: stats ?? undefined, turnId: sm.turnId, mode: sm.mode,
      };
      const msgs     = new Map(s.messages);
      const existing = msgs.get(sessionId as string) ?? [];
      msgs.set(sessionId as string, [...existing, historyItem]);

      return { messages: msgs, streamingMap: streaming };
    });

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
          createdAt: sm.startedAt, turnId: sm.turnId, mode: sm.mode,
        };
        const msgs     = new Map(s.messages);
        const existing = msgs.get(sessionId as string) ?? [];
        msgs.set(sessionId as string, [...existing, partial]);
        return { messages: msgs, streamingMap: streaming, stopReasonMap: stops };
      }

      return { streamingMap: streaming, stopReasonMap: stops };
    });

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

