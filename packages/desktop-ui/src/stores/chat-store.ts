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
import { handleTtsChunk, handleTtsSentenceComplete } from '../lib/tts-playback.js';
import type {
  SessionId,
  TurnId,
  MessageId,
  TurnMode,
  AgentSubMode,
  EmaStreamEvent,
  UsageSummary,
  AssistantBlock,
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

  // Per-session mode memory — keyed by session id
  sessionModes:    Map<string, { mode: TurnMode; subMode?: AgentSubMode }>;

  // Messages — lazy-loaded per session
  messages:        Map<string, ChatHistoryItem[]>;

  // Streaming
  streamingMessage:   StreamingAssistantMessage | null;
  activeTurnId:       TurnId | null;
  /** Which session owns the current stream — used to scope the stop button. */
  streamingSessionId: string | null;

  // Loading
  loading:          { sessions: boolean; messages: Set<string> };
  error:            string | null;

  /**
   * Transient stop message shown briefly after abort — NOT stored in messages[].
   * Automatically cleared ~3 s after abortStream() sets it.
   */
  stopReason:       string | null;

  // ── Actions ──────────────────────────────────────────────────────────────

  loadSessions():                                   Promise<void>;
  selectSession(id: SessionId):                     Promise<void>;
  createSession():                                  Promise<SessionId>;
  renameSession(id: SessionId, title: string):      Promise<void>;
  pinSession(id: SessionId, pinned: boolean):       Promise<void>;
  setSessionGroup(id: SessionId, label: string | null): Promise<void>;
  setWorkspaceRoots(id: SessionId, paths: string[]): Promise<void>;
  setSessionMode(id: SessionId, mode: TurnMode, subMode?: AgentSubMode): Promise<void>;
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

  /** Client-side stop: cancels the SSE fetch and pushes an abort message. */
  stopStreaming(): void;

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

    // ── Ask-user prompts (forwarded to decision-store) ─────────────────────
    case 'ask_user_required':
      void import('./decision-store.js').then((m) => {
        m.useDecisionStore.getState().push({
          kind:             'ask_user',
          promptId:         event.promptId,
          questions:        event.questions,
          humanDescription: event.humanDescription,
        });
      }).catch(() => {});
      break;

    case 'ask_user_resolved':
      void import('./decision-store.js').then((m) => {
        m.useDecisionStore.getState().dismiss(event.promptId);
      }).catch(() => {});
      break;

    // Permission prompts — forwarded to decision-store so the UI can gate tool use
    case 'permission_required':
      void import('./decision-store.js').then((m) => {
        m.useDecisionStore.getState().push({
          kind:                    'permission',
          promptId:                event.promptId,
          toolName:                event.tool,
          args:                    event.args,
          hint:                    event.hint,
          humanDescription:        event.humanDescription ?? event.hint,
          humanDescriptionPending: event.humanDescription === undefined,
        });
      }).catch(() => {});
      break;

    case 'permission_resolved':
      void import('./decision-store.js').then((m) => {
        m.useDecisionStore.getState().dismiss(event.promptId);
      }).catch(() => {});
      break;

    // ── TTS audio → routed to playback manager (drives Live2D lip-sync) ──
    case 'tts_chunk':
      handleTtsChunk(event);
      break;
    case 'tts_sentence_complete':
      handleTtsSentenceComplete(event);
      break;

    case 'system_warning':
      // Surface TTS / system errors to the console so they're never silent.
      // eslint-disable-next-line no-console
      console.warn('[sse] system_warning:', event.level, event.message);
      break;

    // Ignored events (handled by other stores or system-events stream)
    case 'stage_cue':
    case 'emotion_changed':
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

// ── Active SSE handle (module-level — lets stopStreaming() cancel the fetch) ──

let _activeSseHandle: { stop(): void } | null = null;

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

        // 3. Set active turn + streaming session (scopes the stop button)
        useChatStore.setState({ activeTurnId: turnId, streamingSessionId: sessionId as string });

        // 4. Start SSE consumption
        const url = await turnsApi.eventsUrl(turnId);

        // Create a promise that resolves when the turn ends
        await new Promise<void>((resolve) => {
          _activeSseHandle = sseConsumer.start({
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

        _activeSseHandle = null;
        useChatStore.setState({ activeTurnId: null, streamingSessionId: null });
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
  sessionModes:    new Map(),
  messages:        new Map(),
  streamingMessage:   null,
  activeTurnId:       null,
  streamingSessionId: null,
  loading:            { sessions: false, messages: new Set() },
  error:              null,
  stopReason:         null,

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

    // Restore last-used mode from the session object (already loaded by listGrouped).
    // Falls back to 'chat' if this is a brand-new session with no saved mode.
    const session = get().sessions.byId.get(id as string);
    if (session?.lastMode) {
      set((s) => ({
        sessionModes: new Map(s.sessionModes).set(id as string, {
          mode:    session.lastMode!,
          subMode: session.lastSubMode ?? undefined,
        }),
      }));
    }

    // Lazy-load messages
    if (!get().messages.has(id as string)) {
      set((s) => ({
        loading: { ...s.loading, messages: new Set([...s.loading.messages, id as string]) },
      }));
      try {
        const msgs = await sessionsApi.listMessages(id);
        const history: ChatHistoryItem[] = msgs
          .map((m) => ({
            role:      m.role as ChatHistoryItem['role'],
            ...blocksToHistoryFields(m.role, m.blocks),
            createdAt: m.createdAt,
            messageId: m.id as MessageId,
          }))
          // Drop internal-plumbing messages with no displayable text
          // (e.g. agent tool-result user messages that only contain tool_result blocks)
          .filter((item) => item.content !== '' || item.role === 'assistant');
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
    try {
      const session = await sessionsApi.create();
      await get().loadSessions();
      set({ activeSessionId: session.id as SessionId });
      return session.id as SessionId;
    } catch {
      // Fallback: just clear active session; first turn will auto-create one.
      set({ activeSessionId: null });
      return null as unknown as SessionId;
    }
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

  async setWorkspaceRoots(id, paths) {
    try {
      await sessionsApi.patch(id, { workspaceRoots: paths });
      await get().loadSessions();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : 'Failed to set workspace roots' });
    }
  },

  async setSessionMode(id, mode, subMode) {
    // Optimistic update — UI should feel instant.
    set((s) => ({
      sessionModes: new Map(s.sessionModes).set(id as string, { mode, subMode }),
    }));
    // Persist silently — mode preference is not critical; don't surface errors.
    try {
      await sessionsApi.patch(id, { lastMode: mode, lastSubMode: subMode ?? null });
      // Keep byId in sync so the next selectSession() restores correctly.
      set((s) => {
        const existing = s.sessions.byId.get(id as string);
        if (!existing) return {};
        const byId = new Map(s.sessions.byId);
        byId.set(id as string, { ...existing, lastMode: mode, lastSubMode: subMode ?? null });
        return { sessions: { ...s.sessions, byId } };
      });
    } catch {
      // silent
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

    // Push optimistic user message — only when we already have a session so
    // the message lands in the right bucket. On first-message (no active session)
    // the backend round-trip is fast; selectSession() will load the real persisted
    // message instead, avoiding an orphaned entry under the null key.
    const userText = input.text ?? '';
    if (userText && state.activeSessionId) {
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

  stopStreaming() {
    _activeSseHandle?.stop();
    _activeSseHandle = null;
    get().abortStream('已停止');
  },

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
                // Use null (not undefined) as "completed with no output" so hasResult stays true
                ? { ...sl, result: tr.output ?? null, error: tr.error }
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
        streamingMessage:   null,
        activeTurnId:       null,
        streamingSessionId: null,
      };
    });
  },

  abortStream(reason) {
    set((s) => {
      const sm = s.streamingMessage;
      if (!sm) return { streamingMessage: null, activeTurnId: null, streamingSessionId: null, stopReason: reason };

      // Keep the partial message if there's any visible content OR any tool
      // call slices (agent turns that only called tools have no text content).
      if (sm.content.trim() || sm.slices.length > 0) {
        const partialItem: ChatHistoryItem = {
          role:      'assistant',
          content:   sm.content,
          slices:    sm.slices,
          createdAt: sm.startedAt,
        };
        const next = new Map(s.messages);
        const sid = s.activeSessionId as string;
        const existing = next.get(sid) ?? [];
        next.set(sid, [...existing, partialItem]);
        return { messages: next, streamingMessage: null, activeTurnId: null, streamingSessionId: null, stopReason: reason };
      }

      // No partial content — just clear stream state and show the banner
      return { streamingMessage: null, activeTurnId: null, streamingSessionId: null, stopReason: reason };
    });

    // Auto-dismiss the stop banner after 3 s
    setTimeout(() => {
      useChatStore.setState({ stopReason: null });
    }, 3000);
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Reconstruct `content` + `slices` from the persisted MessageBlocks format
 * so historical messages render identically to freshly-streamed ones.
 *
 * Parsing rules match the contracts/messages.ts comment:
 *   string          → plain text (system / simple user)
 *   AssistantBlock[] → role='assistant' rich blocks
 *   UserBlock[]     → role='user' with media / tool_results
 */
function blocksToHistoryFields(
  role: string,
  blocks: import('@ema-agent/contracts').MessageBlocks,
): Pick<ChatHistoryItem, 'content' | 'slices'> {
  if (typeof blocks === 'string') {
    return { content: blocks };
  }

  if (role === 'assistant' && Array.isArray(blocks)) {
    const ab = blocks as AssistantBlock[];
    const slices: AssistantSlice[] = ab.map((b) => {
      if (b.type === 'text')     return { type: 'text'      as const, text: b.text };
      if (b.type === 'thinking') return { type: 'thinking'  as const, text: b.thinking };
      // tool_use — no result yet (result is injected via tool_result events during streaming)
      return { type: 'tool_call' as const, callId: b.id, name: b.name, args: b.args };
    });
    const content = ab
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { content, slices };
  }

  // User message with multimodal content or pure tool_result blocks.
  // Extract any visible text; if there's none (e.g. agent tool-result injections)
  // return empty string so the caller can filter the item out instead of showing
  // a confusing "[multimodal]" placeholder.
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
  if (last && last.type === 'text') {
    return [
      ...slices.slice(0, -1),
      { ...last, text: (last.text ?? '') + delta },
    ];
  }
  return [...slices, { type: 'text', text: delta }];
}
