/**
 * Chat store — session management + message loading + streaming + send queue.
 *
 * This is the most complex store (~300 lines). It orchestrates:
 *   1. Session CRUD (load / select / create / rename / pin / fork / archive / delete)
 *   2. Send queue (serialised, one turn at a time)
 *   3. SSE stream consumption (beginStream → appendDelta → finalizeStream)
 */
import { create } from 'zustand';
import { createSendQueue, type SendQueue } from '../lib/send-queue.js';
import { sseConsumer } from '../lib/sse-consumer.js';
import { sessionsApi, type SessionWire, type MessageWire } from '../api/sessions.js';
import { turnsApi } from '../api/turns.js';
import type {
  SessionId,
  TurnId,
  MessageId,
  TurnMode,
  AgentSubMode,
  EmaStreamEvent,
  UsageSummary,
} from '@ema-agent/contracts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AssistantSlice {
  type:     'text' | 'thinking' | 'tool_call';
  text?:    string;
  callId?:  string;
  name?:    string;
  args?:    unknown;
  result?:  unknown;
  error?:   { code: string; message: string };
}

export interface StreamingAssistantMessage {
  role:      'assistant';
  content:   string;
  slices:    AssistantSlice[];
  startedAt: number;
}

export interface ChatHistoryItem {
  role:      'system' | 'user' | 'assistant' | 'error';
  content:   string;
  slices?:   AssistantSlice[];
  createdAt: number;
  messageId?: MessageId;
}

interface SessionsState {
  pinned:   SessionWire[];
  byGroup:  Array<{ label: string; sessions: SessionWire[] }>;
  recent:   SessionWire[];
  archived: SessionWire[];
  byId:     Map<string, SessionWire>;
}

export interface ChatStoreState {
  // Sessions
  sessions:        SessionsState;
  activeSessionId: SessionId | null;

  // Messages — lazy-loaded per session
  messages:        Map<string, ChatHistoryItem[]>;

  // Streaming
  streamingMessage: StreamingAssistantMessage | null;
  activeTurnId:     TurnId | null;

  // Loading
  loading:          { sessions: boolean; messages: Set<string> };
  error:            string | null;

  // ── Actions ──────────────────────────────────────────────────────────────

  loadSessions():                                   Promise<void>;
  selectSession(id: SessionId):                     Promise<void>;
  createSession():                                  Promise<SessionId>;
  renameSession(id: SessionId, title: string):      Promise<void>;
  pinSession(id: SessionId, pinned: boolean):       Promise<void>;
  setSessionGroup(id: SessionId, label: string | null): Promise<void>;
  forkSession(id: SessionId):                       Promise<SessionId>;
  archiveSession(id: SessionId):                    Promise<void>;
  unarchiveSession(id: SessionId):                  Promise<void>;
  deleteSession(id: SessionId):                     Promise<void>;

  sendMessage(input: {
    mode:         TurnMode;
    subMode?:     AgentSubMode;
    text?:        string;
    contentParts?: unknown[];
    model?:       string;
    ttsEnabled?:  boolean;
  }): Promise<void>;

  beginStream(turnId: TurnId): void;
  appendDelta(slice: 'text' | 'thinking' | 'tool_call' | 'tool_result', delta: string | { callId: string; name: string; args: unknown } | { callId: string; output?: unknown; error?: { code: string; message: string } }): void;
  finalizeStream(usage: UsageSummary | null): void;
  abortStream(reason: string): void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptySessions(): SessionsState {
  return {
    pinned:   [],
    byGroup:  [],
    recent:   [],
    archived: [],
    byId:     new Map(),
  };
}

function rebuildById(sessions: SessionsState): void {
  sessions.byId = new Map();
  for (const s of sessions.pinned)   sessions.byId.set(s.id, s);
  for (const g of sessions.byGroup)  for (const s of g.sessions) sessions.byId.set(s.id, s);
  for (const s of sessions.recent)   sessions.byId.set(s.id, s);
  for (const s of sessions.archived) sessions.byId.set(s.id, s);
}

function optimisticUserMessage(text: string): ChatHistoryItem {
  return { role: 'user', content: text, createdAt: Date.now() };
}

// ── SSE event dispatcher ─────────────────────────────────────────────────────

function dispatchSseEvent(
  event: EmaStreamEvent,
  store: {
    beginStream: (turnId: TurnId) => void;
    appendDelta: ChatStoreState['appendDelta'];
    finalizeStream: (usage: UsageSummary | null) => void;
    abortStream: (reason: string) => void;
  },
): void {
  switch (event.type) {
    case 'turn_started':
      store.beginStream(event.turnId);
      break;

    case 'output_text_delta':
      store.appendDelta('text', event.delta);
      break;

    case 'reasoning_delta':
      store.appendDelta('thinking', event.delta);
      break;

    case 'tool_call_complete':
      store.appendDelta('tool_call', {
        callId: event.callId,
        name:   event.name,
        args:   event.args,
      });
      break;

    case 'tool_result':
      store.appendDelta('tool_result', {
        callId: event.callId,
        output: event.output,
        error:  event.error,
      });
      break;

    case 'turn_completed':
      store.finalizeStream(event.usage);
      break;

    case 'turn_failed':
      store.abortStream(event.message);
      break;

    case 'turn_aborted':
      store.abortStream(event.reason);
      break;

    // Ignored events (handled by other stores or system-events stream)
    case 'permission_required':
    case 'permission_resolved':
    case 'stage_cue':
    case 'emotion_changed':
    case 'tts_chunk':
    case 'tts_sentence_complete':
    case 'artifact_upserted':
    case 'artifact_applied':
    case 'narrative_route_resolved':
    case 'narrative_timeline_complete':
    case 'context_compacted':
    case 'recall_evidence':
    case 'character_card_switched':
    case 'output_text_complete':
    case 'reasoning_complete':
    case 'tool_call_partial':
      break;

    default:
      // Exhaustiveness — unknown events are silently ignored
      break;
  }
}

// ── Send queue (module-level singleton — survives store re-renders) ───────────

interface SendInput {
  mode:         TurnMode;
  subMode?:     AgentSubMode;
  text?:        string;
  contentParts?: unknown[];
  model?:       string;
  ttsEnabled?:  boolean;
}

let _sendQueue: SendQueue<SendInput> | null = null;

function getSendQueue(): SendQueue<SendInput> {
  if (!_sendQueue) {
    _sendQueue = createSendQueue<SendInput>({
      async handler(input) {
        const state = useChatStore.getState();

        // 1. Create the turn
        const { turnId, sessionId } = await turnsApi.create({
          sessionId: state.activeSessionId ?? undefined,
          mode:      input.mode,
          subMode:   input.subMode,
          userInput: input.text,
          contentParts: input.contentParts as any,
          model:     input.model,
          ttsEnabled: input.ttsEnabled,
        });

        // 2. If this created a new session, select it
        if (state.activeSessionId !== sessionId) {
          await useChatStore.getState().selectSession(sessionId);
        }

        // 3. Set active turn
        useChatStore.setState({ activeTurnId: turnId });

        // 4. Start SSE consumption
        const url = await turnsApi.eventsUrl(turnId);

        // Create a promise that resolves when the turn ends
        await new Promise<void>((resolve) => {
          const handle = sseConsumer.start({
            url,
            onEvent: (event) => {
              dispatchSseEvent(event, {
                beginStream: (tid) => useChatStore.getState().beginStream(tid),
                appendDelta: (slice, delta) => useChatStore.getState().appendDelta(slice, delta),
                finalizeStream: (usage) => {
                  useChatStore.getState().finalizeStream(usage);
                  resolve();
                },
                abortStream: (reason) => {
                  useChatStore.getState().abortStream(reason);
                  resolve();
                },
              });
            },
            onHeartbeat: () => {},
            onError: (err) => {
              console.error('[chat-store] SSE error', err);
              useChatStore.getState().abortStream(err.message);
              resolve();
            },
            onComplete: () => {
              resolve();
            },
          });
        });

        useChatStore.setState({ activeTurnId: null });
      },
      continueOnError: true,
    });
  }
  return _sendQueue;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useChatStore = create<ChatStoreState>((set, get) => ({
  sessions:        emptySessions(),
  activeSessionId: null,
  messages:        new Map(),
  streamingMessage: null,
  activeTurnId:    null,
  loading:         { sessions: false, messages: new Set() },
  error:           null,

  // ── Session management ──────────────────────────────────────────────────

  async loadSessions() {
    set((s) => ({ loading: { ...s.loading, sessions: true }, error: null }));
    try {
      const grouped = await sessionsApi.listGrouped();
      const sessions: SessionsState = {
        pinned:   grouped.pinned,
        byGroup:  grouped.byGroup,
        recent:   grouped.recent,
        archived: grouped.archived,
        byId:     new Map(),
      };
      rebuildById(sessions);
      set({ sessions, loading: { ...get().loading, sessions: false } });
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : 'Failed to load sessions',
        loading: { ...get().loading, sessions: false },
      });
    }
  },

  async selectSession(id) {
    if (get().activeSessionId === id) return; // no-op
    set({ activeSessionId: id });

    // Lazy-load messages
    if (!get().messages.has(id as string)) {
      set((s) => ({
        loading: { ...s.loading, messages: new Set([...s.loading.messages, id as string]) },
      }));
      try {
        const msgs = await sessionsApi.listMessages(id);
        const history: ChatHistoryItem[] = msgs.map((m) => ({
          role:      m.role as ChatHistoryItem['role'],
          content:   typeof m.blocks === 'string' ? m.blocks : JSON.stringify(m.blocks),
          createdAt: m.createdAt,
          messageId: m.id as MessageId,
        }));
        set((s) => {
          const next = new Map(s.messages);
          next.set(id as string, history);
          const loading = new Set(s.loading.messages);
          loading.delete(id as string);
          return { messages: next, loading: { ...s.loading, messages: loading } };
        });
      } catch (err: unknown) {
        set((s) => {
          const loading = new Set(s.loading.messages);
          loading.delete(id as string);
          return {
            error: err instanceof Error ? err.message : 'Failed to load messages',
            loading: { ...s.loading, messages: loading },
          };
        });
      }
    }
  },

  async createSession() {
    // Create via turns API with empty input will auto-create a session
    // Actually, let's call sessions API directly... but there's no "create session" endpoint!
    // The backend creates sessions on first turn. For now, just reload.
    // V1.5: add POST /api/sessions endpoint.
    await get().loadSessions();
    return get().activeSessionId ?? '' as SessionId;
  },

  async renameSession(id, title) {
    try {
      await sessionsApi.patch(id, { title });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to rename session' });
    }
  },

  async pinSession(id, pinned) {
    try {
      await sessionsApi.patch(id, { pinned });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to pin session' });
    }
  },

  async setSessionGroup(id, label) {
    try {
      await sessionsApi.patch(id, { groupLabel: label });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to set group' });
    }
  },

  async forkSession(id) {
    try {
      const result = await sessionsApi.fork(id);
      const newId = result.sessionId as SessionId;
      await get().loadSessions();
      await get().selectSession(newId);
      return newId;
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to fork session' });
      throw err;
    }
  },

  async archiveSession(id) {
    try {
      await sessionsApi.archive(id);
      if (get().activeSessionId === id) {
        set({ activeSessionId: null });
      }
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to archive session' });
    }
  },

  async unarchiveSession(id) {
    try {
      await sessionsApi.unarchive(id);
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to unarchive session' });
    }
  },

  async deleteSession(id) {
    try {
      await sessionsApi.delete(id);
      if (get().activeSessionId === id) {
        set({ activeSessionId: null });
      }
      // Clean local messages
      set((s) => {
        const next = new Map(s.messages);
        next.delete(id as string);
        return { messages: next };
      });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete session' });
    }
  },

  // ── Send ─────────────────────────────────────────────────────────────────

  async sendMessage(input) {
    const state = get();
    if (!state.activeSessionId) {
      // Auto-create: first turn creates a session
      set({ error: null });
    }

    // Push optimistic user message
    const userText = input.text ?? '';
    if (userText) {
      const optimistic = optimisticUserMessage(userText);
      set((s) => {
        const next = new Map(s.messages);
        const sid = s.activeSessionId as string;
        const existing = next.get(sid) ?? [];
        next.set(sid, [...existing, optimistic]);
        return { messages: next };
      });
    }

    // Enqueue
    const queue = getSendQueue();
    await queue.enqueue({
      mode:         input.mode,
      subMode:      input.subMode,
      text:         input.text,
      contentParts: input.contentParts,
      model:        input.model,
      ttsEnabled:   input.ttsEnabled,
    });
  },

  // ── Stream lifecycle ─────────────────────────────────────────────────────

  beginStream(turnId) {
    set({
      activeTurnId: turnId,
      streamingMessage: {
        role:      'assistant',
        content:   '',
        slices:    [],
        startedAt: Date.now(),
      },
    });
  },

  appendDelta(slice, delta) {
    set((s) => {
      const sm = s.streamingMessage;
      if (!sm) {
        console.warn('[chat-store] appendDelta called with no streamingMessage');
        return {};
      }

      if (slice === 'text' && typeof delta === 'string') {
        return {
          streamingMessage: {
            ...sm,
            content: sm.content + delta,
            slices: appendTextSlice(sm.slices, delta),
          },
        };
      }

      if (slice === 'thinking' && typeof delta === 'string') {
        return {
          streamingMessage: {
            ...sm,
            slices: [...sm.slices, { type: 'thinking', text: delta }],
          },
        };
      }

      if (slice === 'tool_call' && typeof delta === 'object') {
        const tc = delta as { callId: string; name: string; args: unknown };
        return {
          streamingMessage: {
            ...sm,
            slices: [...sm.slices, {
              type:   'tool_call',
              callId: tc.callId,
              name:   tc.name,
              args:   tc.args,
            }],
          },
        };
      }

      if (slice === 'tool_result' && typeof delta === 'object') {
        const tr = delta as { callId: string; output?: unknown; error?: { code: string; message: string } };
        return {
          streamingMessage: {
            ...sm,
            slices: sm.slices.map((sl) =>
              sl.type === 'tool_call' && sl.callId === tr.callId
                ? { ...sl, result: tr.output, error: tr.error }
                : sl,
            ),
          },
        };
      }

      return {};
    });
  },

  finalizeStream(_usage) {
    set((s) => {
      const sm = s.streamingMessage;
      // Even on the "no streamingMessage" path we clear activeTurnId — the
      // turn lifecycle has ended one way or another.
      if (!sm) return { streamingMessage: null, activeTurnId: null };

      const historyItem: ChatHistoryItem = {
        role:      'assistant',
        content:   sm.content,
        slices:    sm.slices,
        createdAt: Date.now(),
      };

      const next = new Map(s.messages);
      const sid = s.activeSessionId as string;
      const existing = next.get(sid) ?? [];
      next.set(sid, [...existing, historyItem]);

      // Refresh sessions to get updated runningTurnCount etc. Fire-and-forget
      // — UI consumers don't await this. We swallow errors so a fetch failure
      // during a unit test doesn't crash the action.
      void get().loadSessions().catch(() => { /* non-fatal */ });

      return {
        messages: next,
        streamingMessage: null,
        activeTurnId: null,
      };
    });
  },

  abortStream(reason) {
    set((s) => {
      if (!s.streamingMessage) return { streamingMessage: null, activeTurnId: null };

      // Push an error item
      const errorItem: ChatHistoryItem = {
        role:      'error',
        content:   reason,
        createdAt: Date.now(),
      };

      const next = new Map(s.messages);
      const sid = s.activeSessionId as string;
      const existing = next.get(sid) ?? [];
      next.set(sid, [...existing, errorItem]);

      return {
        messages: next,
        streamingMessage: null,
        activeTurnId: null,
      };
    });
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function appendTextSlice(slices: AssistantSlice[], delta: string): AssistantSlice[] {
  const last = slices[slices.length - 1];
  if (last && last.type === 'text') {
    return [
      ...slices.slice(0, -1),
      { ...last, text: (last.text ?? '') + delta },
    ];
  }
  return [...slices, { type: 'text', text: delta }];
}
