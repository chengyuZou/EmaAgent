import { create } from 'zustand';
import { createSendQueue, type SendQueue } from '../lib/send-queue.js';
import { sseConsumer } from '../lib/sse-consumer.js';
import { sessionsApi } from '../api/sessions.js';
import { turnsApi } from '../api/turns.js';
import { handleTtsChunk, handleTtsSentenceComplete } from '../lib/tts-playback.js';
import { useSessionStore } from './session-store.js';
import { useDecisionStore } from './decision-store.js';
import type {
  SessionId,
  TurnId,
  MessageId,
  TurnMode,
  AgentSubMode,
  EmaStreamEvent,
  UsageSummary,
  AssistantBlock,
  MessageBlocks,
  MessageContentPart,
} from '@ema-agent/contracts';

// ── Display types ─────────────────────────────────────────────────────────────

export interface AssistantSlice {
  type:    'text' | 'thinking' | 'tool_call';
  text?:   string;
  callId?: string;
  name?:   string;
  args?:   unknown;
  result?: unknown;
  error?:  { code: string; message: string };
}

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

      const url = await turnsApi.eventsUrl(turnId);

      await new Promise<void>((resolve) => {
        const handle = sseConsumer.start({
          url,
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

type DeltaSlice = 'text' | 'thinking' | 'tool_call' | 'tool_result';
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

function dispatchSseEvent(
  event: EmaStreamEvent,
  sessionId: SessionId,
  cb: StreamCallbacks,
): void {
  switch (event.type) {
    case 'turn_started':
      cb.beginStream(sessionId, event.turnId);
      // Update which session owns TTS/Live2D output
      useConversationStore.setState({ ttsOwnerSessionId: sessionId });
      break;

    case 'output_text_delta':
      cb.appendDelta(sessionId, 'text', event.delta);
      break;

    case 'reasoning_delta':
      cb.appendDelta(sessionId, 'thinking', event.delta);
      break;

    case 'tool_call_complete':
      cb.appendDelta(sessionId, 'tool_call', { callId: event.callId, name: event.name, args: event.args });
      break;

    case 'tool_result':
      cb.appendDelta(sessionId, 'tool_result', { callId: event.callId, output: event.output, error: event.error });
      break;

    case 'turn_completed':
      cb.finalizeStream(sessionId, event.usage);
      break;

    case 'turn_failed':
      cb.abortStream(sessionId, event.message);
      break;

    case 'turn_aborted':
      cb.abortStream(sessionId, event.reason);
      break;

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

    // Handled by system-sse / other stores; or reserved for V1.5
    case 'stage_cue':
    case 'emotion_changed':
    case 'artifact_upserted':
    case 'artifact_applied':
    case 'narrative_route_resolved':
    case 'narrative_timeline_complete':
    case 'memory_recall_evidence':
    case 'reasoning_complete':
    case 'tool_call_partial':
    case 'agent_iteration':
    case 'agent_breaker_tripped':
      break;

    default:
      break;
  }
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface ConversationStoreState {
  viewedSessionId:   SessionId | null;
  ttsOwnerSessionId: SessionId | null;
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
    set((s) => {
      const msgs = new Map(s.messages);
      msgs.delete(id as string);
      const streaming = new Map(s.streamingMap);
      streaming.delete(id as string);
      const stops = new Map(s.stopReasonMap);
      stops.delete(id as string);
      const drafts = new Map(s.draftMap);
      drafts.delete(id as string);
      return { messages: msgs, streamingMap: streaming, stopReasonMap: stops, draftMap: drafts };
    });
  },

  // ── Stream lifecycle ─────────────────────────────────────────────────────

  beginStream(sessionId, turnId) {
    set((s) => {
      const streaming = new Map(s.streamingMap);
      streaming.set(sessionId as string, {
        role: 'assistant', content: '', slices: [], startedAt: Date.now(),
      });
      // Clear any previous stop reason for this session
      const stops = new Map(s.stopReasonMap);
      stops.delete(sessionId as string);
      return { streamingMap: streaming, stopReasonMap: stops };
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
          slices: [...sm.slices, { type: 'thinking', text: delta }],
        });
        return { streamingMap: streaming };
      }

      if (slice === 'tool_call' && typeof delta === 'object') {
        const tc = delta as { callId: string; name: string; args: unknown };
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, {
          ...sm,
          slices: [...sm.slices, { type: 'tool_call', callId: tc.callId, name: tc.name, args: tc.args }],
        });
        return { streamingMap: streaming };
      }

      if (slice === 'tool_result' && typeof delta === 'object') {
        const tr = delta as { callId: string; output?: unknown; error?: { code: string; message: string } };
        const streaming = new Map(s.streamingMap);
        streaming.set(sessionId as string, {
          ...sm,
          slices: sm.slices.map((sl) =>
            sl.type === 'tool_call' && sl.callId === tr.callId
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
      if (b.type === 'thinking') return { type: 'thinking' as const, text: b.thinking };
      return { type: 'tool_call' as const, callId: b.id, name: b.name, args: b.args };
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
    return [...slices.slice(0, -1), { ...last, text: (last.text ?? '') + delta }];
  }
  return [...slices, { type: 'text', text: delta }];
}
