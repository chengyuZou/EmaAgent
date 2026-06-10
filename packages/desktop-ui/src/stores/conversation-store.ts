import { create } from 'zustand';
import { createSendQueue, type SendQueue } from '../lib/send-queue.js';
import { sseConsumer } from '../lib/sse-consumer.js';
import { sessionsApi } from '../api/sessions.js';
import { turnsApi } from '../api/turns.js';
import { sidecarClient } from '../api/sidecar-client.js';
import {
  handleTtsChunk,
  handleTtsSentenceComplete,
  handleTurnCompleted,
  handleTurnAborted,
  evictSessionPlayers,
} from '../lib/tts-playback.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { useSessionStore } from './session-store.js';
import { useDecisionStore } from './decision-store.js';
import { useArtifactStore } from './artifact-store.js';
import type {
  SessionId,
  TurnId,
  MessageId,
  TurnMode,
  AgentSubMode,
  EmaStreamEvent,
  EmotionState,
  UsageSummary,
  AssistantBlock,
  MessageBlocks,
  MessageContentPart,
  MemoryRecallLayer,
  MemoryRecallLayerReport,
} from '@ema-agent/contracts';

// ── Display types ─────────────────────────────────────────────────────────────

export type AssistantSlice =
  | { type: 'text';             text: string }
  | { type: 'thinking';         thinking: string; done?: boolean }
  | { type: 'tool_use';         callId: string; name: string; args?: unknown; partialArgs?: string;
                                result?: unknown; error?: { code: string; message: string } }
  | { type: 'narrative_status'; timelines: string[]; completedTimelines: string[];
                                snippets: Record<string, string> };

export interface StreamingAssistantMessage {
  role:      'assistant';
  content:   string;
  slices:    AssistantSlice[];
  startedAt: number;
}

export interface ChatHistoryItem {
  role:       'system' | 'user' | 'assistant' | 'error';
  content:    string;
  slices?:    AssistantSlice[];
  createdAt:  number;
  messageId?: MessageId;
}

// ── Send input ────────────────────────────────────────────────────────────────

interface SendInput {
  sessionId:     SessionId;
  mode:          TurnMode;
  agentSubMode?: AgentSubMode;
  text?:         string;
  contentParts?: MessageContentPart[];
  model?:        string;
  ttsEnabled?:   boolean;
}

// ── Module-level per-session resources (no underscore; module-private via no export) ──

const sseHandles = new Map<string, { stop(): void }>();
const sendQueues = new Map<string, SendQueue<SendInput>>();

function getOrCreateQueue(sessionId: SessionId): SendQueue<SendInput> {
  const key = sessionId as string;
  let queue = sendQueues.get(key);
  if (queue) return queue;

  queue = createSendQueue<SendInput>({
    async handler(input) {
      const store = useConversationStore.getState();

      const { turnId, sessionId: actualSessionId } = await turnsApi.create({
        sessionId:     input.sessionId as string,
        mode:          input.mode,
        agentSubMode:  input.agentSubMode,
        userInput:     input.text,
        contentParts:  input.contentParts,
        model:         input.model,
        ttsEnabled:    input.ttsEnabled,
      });

      // Backend may have created a new session (when input.sessionId was auto-generated).
      // If so, reload session list and update viewedSessionId.
      if ((actualSessionId as string) !== (input.sessionId as string)) {
        void useSessionStore.getState().loadSessions();
        useConversationStore.setState({ viewedSessionId: actualSessionId });
      }

      const [url, authHeaders] = await Promise.all([
        turnsApi.eventsUrl(turnId),
        sidecarClient.getAuthHeaders(),
      ]);

      await new Promise<void>((resolve) => {
        const handle = sseConsumer.start({
          url,
          headers: authHeaders,
          onEvent: (event) => dispatchSseEvent(event, input.sessionId, {
            beginStream:    (sid, tid) => useConversationStore.getState().beginStream(sid, tid),
            appendDelta:    (sid, slice, delta) => useConversationStore.getState().appendDelta(sid, slice, delta),
            finalizeStream: (sid, usage) => { useConversationStore.getState().finalizeStream(sid, usage); resolve(); },
            abortStream:    (sid, reason) => { useConversationStore.getState().abortStream(sid, reason); resolve(); },
          }),
          onHeartbeat: () => {},
          onError: (err) => {
            console.error('[conversation-store] SSE error', err);
            useConversationStore.getState().abortStream(input.sessionId, err.message);
            resolve();
          },
          onComplete: () => resolve(),
        });
        sseHandles.set(input.sessionId as string, handle);
      });

      sseHandles.delete(input.sessionId as string);
    },
    continueOnError: true,
  });

  sendQueues.set(key, queue);
  return queue;
}

// ── SSE event dispatcher ─────────────────────────────────────────────────────

type DeltaSlice = 'text' | 'thinking' | 'tool_use' | 'tool_result';
type DeltaPayload =
  | string
  | { callId: string; name: string; args: unknown }
  | { callId: string; output?: unknown; error?: { code: string; message: string } };

interface StreamCallbacks {
  beginStream(sessionId: SessionId, turnId: TurnId): void;
  appendDelta(sessionId: SessionId, slice: DeltaSlice, delta: DeltaPayload): void;
  finalizeStream(sessionId: SessionId, usage: UsageSummary | null): void;
  abortStream(sessionId: SessionId, reason: string): void;
}

// Temp storage for agent_breaker_tripped reasons — cleared when turn_aborted arrives.
const breakerReasons = new Map<string, string>();

function dispatchSseEvent(
  event: EmaStreamEvent,
  sessionId: SessionId,
  cb: StreamCallbacks,
): void {
  switch (event.type) {
    case 'turn_started': {
      cb.beginStream(sessionId, event.turnId);
      const prev = useConversationStore.getState().ttsOwnerSessionId;
      if ((prev as string) !== (sessionId as string)) {
        useConversationStore.setState({ ttsOwnerSessionId: sessionId });
        // Restore the new owner's last known emotion so Live2D doesn't show the
        // previous session's expression after switching.
        const saved = useConversationStore.getState().emotionStateMap.get(sessionId as string);
        if (saved) void tauriBridge.emit('stage:emotion-changed', saved);
      }
      break;
    }

    case 'output_text_delta':
      cb.appendDelta(sessionId, 'text', event.delta);
      break;

    case 'reasoning_delta':
      cb.appendDelta(sessionId, 'thinking', event.delta);
      break;

    case 'tool_call_complete':
      cb.appendDelta(sessionId, 'tool_use', { callId: event.callId, name: event.name, args: event.args });
      break;

    case 'tool_result':
      cb.appendDelta(sessionId, 'tool_result', { callId: event.callId, output: event.output, error: event.error });
      break;

    case 'turn_completed':
      handleTurnCompleted(sessionId as string);
      cb.finalizeStream(sessionId, event.usage);
      break;

    case 'turn_failed':
      breakerReasons.delete(sessionId as string);
      handleTurnAborted(sessionId as string);
      cb.abortStream(sessionId, event.message);
      break;

    case 'turn_aborted': {
      const breakerReason = breakerReasons.get(sessionId as string);
      breakerReasons.delete(sessionId as string);
      handleTurnAborted(sessionId as string);
      cb.abortStream(sessionId, breakerReason ?? event.reason);
      break;
    }

    case 'ask_user_required':
      useDecisionStore.getState().push({
        kind:             'ask_user',
        promptId:         event.promptId,
        turnId:           event.turnId,
        questions:        event.questions,
        humanDescription: event.humanDescription,
      });
      break;

    case 'ask_user_resolved':
      useDecisionStore.getState().dismiss(event.promptId);
      break;

    case 'permission_required':
      useDecisionStore.getState().push({
        kind:                    'permission',
        promptId:                event.promptId,
        toolName:                event.tool,
        args:                    event.args,
        hint:                    event.hint,
        humanDescription:        event.humanDescription ?? event.hint,
        humanDescriptionPending: event.humanDescription === undefined,
      });
      break;

    case 'permission_resolved':
      useDecisionStore.getState().dismiss(event.promptId);
      break;

    case 'tts_chunk':
      handleTtsChunk(event);
      break;

    case 'tts_sentence_complete':
      handleTtsSentenceComplete(event);
      break;

    case 'system_warning':
      console.warn('[sse] system_warning:', event.level, event.message);
      break;

    case 'emotion_changed': {
      // Cache per-session so we can restore Live2D expression on ttsOwner switch.
      useConversationStore.setState((s) => {
        const m = new Map(s.emotionStateMap);
        m.set(event.sessionId as string, event.state);
        return { emotionStateMap: m };
      });
      if ((event.sessionId as string) === (useConversationStore.getState().ttsOwnerSessionId as string)) {
        void tauriBridge.emit('stage:emotion-changed', event.state);
      }
      break;
    }

    case 'stage_cue':
      if ((event.sessionId as string) === (useConversationStore.getState().ttsOwnerSessionId as string)) {
        void tauriBridge.emit('stage:cue', event.cue);
      }
      break;

    case 'artifact_upserted':
      useArtifactStore.getState().upsertFromEvent(event.artifact);
      break;

    case 'artifact_applied':
      useArtifactStore.getState().markAppliedFromEvent(event.id);
      break;

    // Reserved for V1.5
    case 'agent_breaker_tripped':
      breakerReasons.set(sessionId as string, `熔断保护：${event.reason}`);
      break;

    // memory_compaction_* are turn-scoped: emitted by MemoryPlanner.compact() via ctx.emit.
    // No UI change for now — reserved for memory status panel (V1.5).
    case 'memory_compaction_started':
    case 'memory_compaction_completed':
    case 'memory_compaction_failed':
      break;

    case 'agent_iteration':
      useConversationStore.setState((s) => {
        const m = new Map(s.iterationCountMap);
        m.set(sessionId as string, event.n);
        return { iterationCountMap: m };
      });
      break;

    case 'narrative_route_resolved':
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        const slices = [
          ...sm.slices.filter((sl) => sl.type !== 'narrative_status'),
          { type: 'narrative_status' as const, timelines: event.timelines, completedTimelines: [], snippets: {} },
        ];
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices });
        return { streamingMap: streaming };
      });
      break;

    case 'narrative_timeline_complete':
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        const slices = sm.slices.map((sl) =>
          sl.type !== 'narrative_status' ? sl : {
            ...sl,
            completedTimelines: [...(sl.completedTimelines ?? []), event.timeline],
            snippets: { ...(sl.snippets ?? {}), [event.timeline]: event.snippet },
          },
        );
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices });
        return { streamingMap: streaming };
      });
      break;

    case 'reasoning_complete':
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        let thinkingIdx = 0;
        const slices = sm.slices.map((sl) => {
          if (sl.type !== 'thinking') return sl;
          const hit = thinkingIdx === event.blockIndex;
          thinkingIdx++;
          return hit ? { ...sl, done: true } : sl;
        });
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices });
        return { streamingMap: streaming };
      });
      break;

    case 'memory_recall_evidence':
      useConversationStore.setState((s) => {
        const prev = s.recallEvidenceMap.get(sessionId as string) ?? {};
        const next  = new Map(s.recallEvidenceMap);
        next.set(sessionId as string, { ...prev, [event.layer]: event.report });
        return { recallEvidenceMap: next };
      });
      break;

    case 'tool_call_partial':
      useConversationStore.setState((s) => {
        const sm = s.streamingMap.get(sessionId as string);
        if (!sm) return {};
        const idx = sm.slices.findIndex((sl) => sl.type === 'tool_use' && sl.callId === event.callId);
        const slices = idx >= 0
          ? sm.slices.map((sl, i) => {
              if (i !== idx) return sl;
              const tsl = sl as Extract<AssistantSlice, { type: 'tool_use' }>;
              return { ...tsl, partialArgs: (tsl.partialArgs ?? '') + event.argsDelta };
            })
          : [...sm.slices, { type: 'tool_use' as const, callId: event.callId, name: event.name, partialArgs: event.argsDelta }];
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, { ...sm, slices });
        return { streamingMap: streaming };
      });
      break;

    default:
      break;
  }
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface ConversationStoreState {
  viewedSessionId:   SessionId | null;
  ttsOwnerSessionId: SessionId | null;
  /** Last known emotion state per session — restored when ttsOwner switches. */
  emotionStateMap:   Map<string, EmotionState>;
  /** Current agent iteration count per session (resets on each new turn). */
  iterationCountMap:   Map<string, number>;
  /** Memory recall evidence for the latest turn per session (resets on each new turn). */
  recallEvidenceMap:   Map<string, Partial<Record<MemoryRecallLayer, MemoryRecallLayerReport>>>;
  messages:          Map<string, ChatHistoryItem[]>;
  streamingMap:      Map<string, StreamingAssistantMessage>;
  stopReasonMap:     Map<string, string>;
  draftMap:          Map<string, string>;
  loading:           { messages: Set<string> };
  error:             string | null;

  viewSession(id: SessionId):                                           Promise<void>;
  sendMessage(sessionId: SessionId | null, input: Omit<SendInput, 'sessionId'>): Promise<void>;
  stopStreaming(sessionId: SessionId):                                   void;
  setDraft(sessionId: SessionId, text: string):                         void;
  loadMessages(id: SessionId):                                          Promise<void>;
  evictSession(id: SessionId):                                          void;

  beginStream(sessionId: SessionId, turnId: TurnId):                    void;
  appendDelta(sessionId: SessionId, slice: DeltaSlice, delta: DeltaPayload): void;
  finalizeStream(sessionId: SessionId, usage: UsageSummary | null):     void;
  abortStream(sessionId: SessionId, reason: string):                    void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useConversationStore = create<ConversationStoreState>((set, get) => ({
  viewedSessionId:   null,
  ttsOwnerSessionId: null,
  emotionStateMap:   new Map(),
  iterationCountMap: new Map(),
  recallEvidenceMap: new Map(),
  messages:          new Map(),
  streamingMap:      new Map(),
  stopReasonMap:     new Map(),
  draftMap:          new Map(),
  loading:           { messages: new Set() },
  error:             null,

  // ── Navigation ───────────────────────────────────────────────────────────

  async viewSession(id) {
    if (get().viewedSessionId === id) return;
    set({ viewedSessionId: id });

    const session = useSessionStore.getState().sessions.byId.get(id as string);
    if (session?.lastMode) {
      useSessionStore.getState().setSessionMode(id, session.lastMode, session.lastSubMode ?? undefined)
        .catch(() => { /* mode restore is non-critical */ });
    }

    await get().loadMessages(id);
  },

  // ── Messages ─────────────────────────────────────────────────────────────

  async loadMessages(id) {
    if (get().messages.has(id as string)) return;

    set((s) => ({
      loading: { messages: new Set([...s.loading.messages, id as string]) },
    }));
    try {
      const raw = await sessionsApi.listMessages(id);
      const history: ChatHistoryItem[] = raw
        .filter((m) => m.kind === 'normal' || m.kind === 'summary')
        .map((m) => ({
          role:      m.role as ChatHistoryItem['role'],
          ...blocksToHistoryFields(m.role, m.blocks),
          createdAt: m.createdAt,
          messageId: m.id as MessageId,
        }))
        .filter((item) => item.content !== '' || item.role === 'assistant');

      set((s) => {
        const msgs = new Map(s.messages);
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
      void useSessionStore.getState().loadSessions();
      set({ viewedSessionId: targetId });
    }

    if (input.text && get().messages.has(targetId as string)) {
      set((s) => {
        const msgs = new Map(s.messages);
        const existing = msgs.get(targetId as string) ?? [];
        msgs.set(targetId as string, [
          ...existing,
          { role: 'user' as const, content: input.text!, createdAt: Date.now() },
        ]);
        return { messages: msgs };
      });
    }

    // Clear draft on send
    set((s) => {
      const drafts = new Map(s.draftMap);
      drafts.delete(targetId as string);
      return { draftMap: drafts };
    });

    const queue = getOrCreateQueue(targetId);
    await queue.enqueue({ ...input, sessionId: targetId });
  },

  stopStreaming(sessionId) {
    const handle = sseHandles.get(sessionId as string);
    handle?.stop();
    sseHandles.delete(sessionId as string);
    handleTurnAborted(sessionId as string);
    get().abortStream(sessionId, '已停止');
  },

  setDraft(sessionId, text) {
    set((s) => {
      const drafts = new Map(s.draftMap);
      if (text) {
        drafts.set(sessionId as string, text);
      } else {
        drafts.delete(sessionId as string);
      }
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
    set((s) => {
      const msgs = new Map(s.messages);
      msgs.delete(id as string);
      const streaming = new Map(s.streamingMap);
      streaming.delete(id as string);
      const stops = new Map(s.stopReasonMap);
      stops.delete(id as string);
      const drafts = new Map(s.draftMap);
      drafts.delete(id as string);
      const emotions = new Map(s.emotionStateMap);
      emotions.delete(id as string);
      const iterations = new Map(s.iterationCountMap);
      iterations.delete(id as string);
      const recalls = new Map(s.recallEvidenceMap);
      recalls.delete(id as string);
      return { messages: msgs, streamingMap: streaming, stopReasonMap: stops, draftMap: drafts, emotionStateMap: emotions, iterationCountMap: iterations, recallEvidenceMap: recalls };
    });
  },

  // ── Stream lifecycle ─────────────────────────────────────────────────────

  beginStream(sessionId, turnId) {
    set((s) => {
      const streaming = new Map(s.streamingMap);
      streaming.set(sessionId as string, {
        role: 'assistant', content: '', slices: [], startedAt: Date.now(),
      });
      const stops = new Map(s.stopReasonMap);
      stops.delete(sessionId as string);
      const iterations = new Map(s.iterationCountMap);
      iterations.delete(sessionId as string);
      const recalls = new Map(s.recallEvidenceMap);
      recalls.delete(sessionId as string);
      return { streamingMap: streaming, stopReasonMap: stops, iterationCountMap: iterations, recallEvidenceMap: recalls };
    });
    // turnId is stored on the streaming entry so AskUserBatchPrompt can look it up
    // We encode it as a side-channel property (not in the type) — see decision-store instead.
    void turnId; // used indirectly via the per-session SSE handler closure
  },

  appendDelta(sessionId, slice, delta) {
    set((s) => {
      const sm = s.streamingMap.get(sessionId as string);
      if (!sm) return {};

      if (slice === 'text' && typeof delta === 'string') {
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, {
          ...sm,
          content: sm.content + delta,
          slices: appendTextSlice(sm.slices, delta),
        });
        return { streamingMap: streaming };
      }

      if (slice === 'thinking' && typeof delta === 'string') {
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, {
          ...sm,
          slices: appendThinkingSlice(sm.slices, delta),
        });
        return { streamingMap: streaming };
      }

      if (slice === 'tool_use' && typeof delta === 'object') {
        const tc = delta as { callId: string; name: string; args: unknown };
        const existing = sm.slices.findIndex((sl) => sl.type === 'tool_use' && sl.callId === tc.callId);
        const newSlices = existing >= 0
          ? sm.slices.map((sl, i) => {
              if (i !== existing) return sl;
              // findIndex predicate guarantees this is a tool_use slice
              const tsl = sl as Extract<AssistantSlice, { type: 'tool_use' }>;
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

  finalizeStream(sessionId, _usage) {
    set((s) => {
      const sm = s.streamingMap.get(sessionId as string);
      const streaming = new Map(s.streamingMap);
      streaming.delete(sessionId as string);

      if (!sm) return { streamingMap: streaming };

      const historyItem: ChatHistoryItem = {
        role: 'assistant', content: sm.content, slices: sm.slices, createdAt: Date.now(),
      };
      const msgs = new Map(s.messages);
      const existing = msgs.get(sessionId as string) ?? [];
      msgs.set(sessionId as string, [...existing, historyItem]);

      return { messages: msgs, streamingMap: streaming };
    });

    void useSessionStore.getState().loadSessions().catch(() => {});
  },

  abortStream(sessionId, reason) {
    set((s) => {
      const sm = s.streamingMap.get(sessionId as string);
      const streaming = new Map(s.streamingMap);
      streaming.delete(sessionId as string);
      const stops = new Map(s.stopReasonMap);
      stops.set(sessionId as string, reason);

      if (sm && (sm.content.trim() || sm.slices.length > 0)) {
        const partial: ChatHistoryItem = {
          role: 'assistant', content: sm.content, slices: sm.slices, createdAt: sm.startedAt,
        };
        const msgs = new Map(s.messages);
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
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function blocksToHistoryFields(
  role: string,
  blocks: MessageBlocks,
): Pick<ChatHistoryItem, 'content' | 'slices'> {
  if (typeof blocks === 'string') return { content: blocks };

  if (role === 'assistant' && Array.isArray(blocks)) {
    const ab = blocks as AssistantBlock[];
    const slices: AssistantSlice[] = ab.map((b) => {
      if (b.type === 'text')     return { type: 'text'     as const, text: b.text };
      if (b.type === 'thinking') return { type: 'thinking' as const, thinking: b.thinking, done: true };
      return { type: 'tool_use' as const, callId: b.id, name: b.name, args: b.args };
    });
    const content = ab
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { content, slices };
  }

  if (Array.isArray(blocks)) {
    const textParts = (blocks as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    return { content: textParts.join('') };
  }

  return { content: JSON.stringify(blocks) };
}

function appendTextSlice(slices: AssistantSlice[], delta: string): AssistantSlice[] {
  const last = slices[slices.length - 1];
  if (last?.type === 'text') {
    return [...slices.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...slices, { type: 'text', text: delta }];
}

function appendThinkingSlice(slices: AssistantSlice[], delta: string): AssistantSlice[] {
  const last = slices[slices.length - 1];
  if (last?.type === 'thinking') {
    return [...slices.slice(0, -1), { ...last, thinking: last.thinking + delta }];
  }
  return [...slices, { type: 'thinking', thinking: delta }];
}
