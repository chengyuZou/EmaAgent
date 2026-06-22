import { create } from 'zustand';
import { createSendQueue, type SendQueue } from '../lib/send-queue.js';
import { sseConsumer } from '../lib/sse-consumer.js';
import { sessionsApi, type BranchTreeWire } from '../api/sessions.js';
import { turnsApi, type AttachmentInputWire } from '../api/turns.js';

export type { AttachmentInputWire };
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
import { useAgentTaskStore } from './agent-task-store.js';
import type {
  SessionId,
  TurnId,
  MessageId,
  TurnMode,
  EmaStreamEvent,
  EmotionState,
  TurnStats,
  AssistantBlock,
  MessageWire,
  TurnWire,
  ToolResultBlock,
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
  turnId:    TurnId;
  mode?:     TurnMode;
}

export interface ChatHistoryItem {
  role:         'system' | 'user' | 'assistant' | 'error';
  content:      string;
  slices?:      AssistantSlice[];
  createdAt:    number;
  messageId?:   MessageId;
  turnId?:      TurnId;
  stats?:       TurnStats;
  mode?:        TurnMode;
  /** File attachments on user messages — carried from MessageWire.attachments. */
  attachments?: AttachmentInputWire[];
}

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

// ── Module-level per-session resources (no underscore; module-private via no export) ──

const sseHandles = new Map<string, { stop(): void }>();
const sendQueues = new Map<string, SendQueue<SendInput>>();
// Sessions whose first turn hasn't completed yet — trigger title generation on completion.
const pendingTitleSessions = new Set<string>();

function getOrCreateQueue(sessionId: SessionId): SendQueue<SendInput> {
  const key = sessionId as string;
  let queue = sendQueues.get(key);
  if (queue) return queue;

  queue = createSendQueue<SendInput>({
    async handler(input) {
      const store = useConversationStore.getState();

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

      // ── SSE with reconnect ──────────────────────────────────────────────
      // A dropped connection is NOT a dead turn — the backend keeps running
      // and buffers every event in TurnEventStore. We reconnect with
      // lastEventId=cursor (events consumed so far) and the server replays
      // what we missed. Only after MAX_SSE_RETRIES consecutive failures do
      // we give up and surface "连接中断" (which is honest, unlike "已停止").
      const MAX_SSE_RETRIES = 3;
      await new Promise<void>((resolve) => {
        let cursor   = 0;      // events consumed — the replay cursor
        let finished = false;  // terminal event seen OR permanently failed

        const finish = (): void => {
          if (finished) return;
          finished = true;
          resolve();
        };

        const startSse = (attempt: number): void => {
          if (finished) return;   // user stopped while a retry was pending
          const handle = sseConsumer.start({
            url,
            headers: authHeaders,
            lastEventId: cursor,
            onEvent: (event) => {
              cursor += 1;
              const sid = ('sessionId' in event && event.sessionId)
                ? event.sessionId as SessionId
                : input.sessionId;
              dispatchSseEvent(event, sid, {
                beginStream:    (sid, tid, mode) => useConversationStore.getState().beginStream(sid, tid, mode),
                appendDelta:    (sid, slice, delta) => useConversationStore.getState().appendDelta(sid, slice, delta),
                finalizeStream: (sid, stats) => { useConversationStore.getState().finalizeStream(sid, stats); finish(); },
                abortStream:    (sid, reason) => { useConversationStore.getState().abortStream(sid, reason); finish(); },
              });
            },
            onHeartbeat: () => {},
            onError: (err) => {
              if (!finished && attempt < MAX_SSE_RETRIES) {
                const delay = 1000 * 2 ** attempt;
                console.warn(`[conversation-store] SSE dropped, retry ${attempt + 1}/${MAX_SSE_RETRIES} in ${delay}ms:`, err.message);
                setTimeout(() => {
                  // User may have hit stop while we waited: stopStreaming
                  // clears the streamingMap entry. cursor > 0 guarantees the
                  // entry existed (turn_started → beginStream), so its absence
                  // now means "user gave up" — don't resurrect the stream.
                  const stillStreaming = useConversationStore.getState()
                    .streamingMap.has(input.sessionId as string);
                  if (cursor > 0 && !stillStreaming) {
                    finish();
                    return;
                  }
                  startSse(attempt + 1);
                }, delay);
                return;
              }
              console.error('[conversation-store] SSE failed permanently', err);
              useConversationStore.getState().abortStream(input.sessionId, `连接中断：${err.message}`);
              finish();
            },
            // Fires on natural stream end AND on user stop() — either way the
            // queue must move on. (Terminal events already called finish().)
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

// ── SSE event dispatcher ─────────────────────────────────────────────────────

type DeltaSlice = 'text' | 'thinking' | 'tool_use' | 'tool_result';
type DeltaPayload =
  | string
  | { callId: string; name: string; args: unknown }
  | { callId: string; output?: unknown; error?: { code: string; message: string } };

interface StreamCallbacks {
  beginStream(sessionId: SessionId, turnId: TurnId, mode?: TurnMode): void;
  appendDelta(sessionId: SessionId, slice: DeltaSlice, delta: DeltaPayload): void;
  finalizeStream(sessionId: SessionId, stats: TurnStats | null): void;
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
      cb.beginStream(sessionId, event.turnId, event.mode);
      // Clear live usage + thinking for this turn (keyed by turnId, not sessionId —
      // AssistantBubble looks these up by the specific turn it's rendering).
      useConversationStore.setState((s) => {
        const u = new Map(s.liveUsageMap);
        u.delete(event.turnId as string);
        const t = new Map(s.thinkingActiveMap);
        t.delete(event.turnId as string);
        return { liveUsageMap: u, thinkingActiveMap: t };
      });
      const prev = useConversationStore.getState().ttsOwnerSessionId;
      if ((prev as string) !== (sessionId as string)) {
        useConversationStore.setState({ ttsOwnerSessionId: sessionId });
        const saved = useConversationStore.getState().emotionStateMap.get(sessionId as string);
        if (saved) void tauriBridge.emit('stage:emotion-changed', saved);
      }
      break;
    }

    case 'usage_update':
      useConversationStore.setState((s) => {
        const m = new Map(s.liveUsageMap);
        m.set(event.turnId as string, { inputTokens: event.inputTokens, outputTokens: event.outputTokens });
        return { liveUsageMap: m };
      });
      break;

    case 'output_text_delta':
      cb.appendDelta(sessionId, 'text', event.delta);
      break;

    case 'reasoning_delta':
      cb.appendDelta(sessionId, 'thinking', event.delta);
      useConversationStore.setState((s) => {
        // Event carries no turnId — recover it from the live streaming entry.
        const turnId = s.streamingMap.get(sessionId as string)?.turnId;
        if (!turnId) return {};
        const t = new Map(s.thinkingActiveMap);
        t.set(turnId as string, true);
        return { thinkingActiveMap: t };
      });
      break;

    case 'tool_call_complete':
      cb.appendDelta(sessionId, 'tool_use', { callId: event.callId, name: event.name, args: event.args });
      break;

    case 'tool_result':
      cb.appendDelta(sessionId, 'tool_result', { callId: event.callId, output: event.output, error: event.error });
      break;

    case 'turn_completed':
      handleTurnCompleted(sessionId as string);
      cb.finalizeStream(sessionId, event.stats);
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
        sessionId:        sessionId as string,
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
        sessionId:               sessionId as string,
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

    // ── Subagent lifecycle ─────────────────────────────────────────────────
    case 'subagent_started':
      useAgentTaskStore.getState().upsert({
        id:          event.subagentId,
        sessionId:   event.sessionId as string,
        turnId:      null,
        parentId:    event.parentTurnId as string,
        status:      'running',
        createdAt:   event.startedAtMs,
        updatedAt:   event.startedAtMs,
        parentTurnId: event.parentTurnId as string,
        live: {
          startedAtMs:   event.startedAtMs,
          promptExcerpt: event.promptExcerpt,
          model:         event.model,
          iteration:     0,
          toolCallCount: 0,
          elapsedMs:     0,
        },
      });
      break;

    case 'subagent_progress': {
      const existing = useAgentTaskStore.getState().tasks.get(event.subagentId);
      useAgentTaskStore.getState().upsert({
        id:      event.subagentId,
        status:  'running',
        live: {
          startedAtMs:   existing?.live?.startedAtMs   ?? Date.now(),
          promptExcerpt: existing?.live?.promptExcerpt ?? '',
          model:         existing?.live?.model         ?? '',
          iteration:     event.iteration,
          toolCallCount: event.toolCallCount,
          elapsedMs:     event.elapsedMs,
        },
      });
      break;
    }

    case 'subagent_completed':
      useAgentTaskStore.getState().upsert({
        id:          event.subagentId,
        status:      'completed',
        updatedAt:   Date.now(),
        iterations:  event.iterationCount,
        inputTokens: event.stats.inputTokens,
        outputTokens: event.stats.outputTokens,
        live: undefined,
      });
      break;

    case 'subagent_failed':
      useAgentTaskStore.getState().upsert({
        id:        event.subagentId,
        status:    'failed',
        error:     event.error,
        updatedAt: Date.now(),
        live:      undefined,
      });
      break;

    case 'subagent_aborted':
      useAgentTaskStore.getState().upsert({
        id:        event.subagentId,
        status:    'cancelled',
        error:     event.reason,
        updatedAt: Date.now(),
        live:      undefined,
      });
      break;

    case 'subagent_stream':
      // Transcript messages are written to the DB by turns.ts fan-out.
      // The store's transcript cache may be stale — invalidate on next open.
      // (No live streaming into transcript yet; panel reloads from server.)
      break;

    // ── Compaction notice ──────────────────────────────────────────────────
    case 'memory_compaction_started':
    case 'memory_compaction_failed':
      break;

    case 'memory_compaction_completed':
      useConversationStore.setState((s) => {
        const msgs = new Map(s.messages);
        const existing = msgs.get(sessionId as string) ?? [];
        const notice: ChatHistoryItem = {
          role:      'system',
          content:   `📋 上下文已压缩 · 节省 ${event.savedTokens.toLocaleString()} tokens`,
          createdAt: Date.now(),
        };
        msgs.set(sessionId as string, [...existing, notice]);
        return { messages: msgs };
      });
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
        const t = new Map(s.thinkingActiveMap);
        t.delete(sm.turnId as string);
        return { streamingMap: streaming, thinkingActiveMap: t };
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
  /** Live token usage from provider during streaming (key = turnId — AssistantBubble reads by turnId). */
  liveUsageMap:      Map<string, { inputTokens: number; outputTokens: number }>;
  /** Whether reasoning/thinking is currently active (key = turnId — AssistantBubble reads by turnId). */
  thinkingActiveMap: Map<string, boolean>;
  messages:          Map<string, ChatHistoryItem[]>;
  streamingMap:      Map<string, StreamingAssistantMessage>;
  stopReasonMap:     Map<string, string>;
  draftMap:          Map<string, string>;
  loading:           { messages: Set<string> };
  error:             string | null;
  /** Set to scroll ChatHistory to a specific turn. Reset to null after consuming. */
  scrollToTurnId:    string | null;
  /** Branch tree per session — used by AssistantBubble for sibling `< N/M >` navigation. */
  branchDataBySession: Map<string, BranchTreeWire>;

  viewSession(id: SessionId):                                           Promise<void>;
  scrollToTurn(turnId: string):                                         void;
  loadBranches(id: SessionId):                                          Promise<void>;
  sendMessage(sessionId: SessionId | null, input: Omit<SendInput, 'sessionId'>): Promise<void>;
  stopStreaming(sessionId: SessionId):                                   void;
  setDraft(sessionId: SessionId, text: string):                         void;
  loadMessages(id: SessionId):                                          Promise<void>;
  evictSession(id: SessionId):                                          void;

  beginStream(sessionId: SessionId, turnId: TurnId, mode?: TurnMode):   void;
  appendDelta(sessionId: SessionId, slice: DeltaSlice, delta: DeltaPayload): void;
  finalizeStream(sessionId: SessionId, stats: TurnStats | null):     void;
  abortStream(sessionId: SessionId, reason: string):                    void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useConversationStore = create<ConversationStoreState>((set, get) => ({
  viewedSessionId:   null,
  ttsOwnerSessionId: null,
  emotionStateMap:   new Map(),
  iterationCountMap: new Map(),
  recallEvidenceMap: new Map(),
  liveUsageMap:      new Map(),
  thinkingActiveMap: new Map(),
  messages:          new Map(),
  streamingMap:      new Map(),
  stopReasonMap:     new Map(),
  draftMap:          new Map(),
  loading:           { messages: new Set() },
  error:             null,
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

    // Update last_viewed_at in SQL then reload so hasUnread resets in the sidebar.
    void sessionsApi.markViewed(id)
      .then(() => useSessionStore.getState().loadSessions())
      .catch(() => {});

    const session = useSessionStore.getState().sessions.byId.get(id as string);
    if (session?.lastMode) {
      useSessionStore.setState((s) => ({
        sessionModes: new Map(s.sessionModes).set(id as string, {
          mode: session.lastMode!,
        }),
      }));
    }

    await get().loadMessages(id);
    void get().loadBranches(id); // non-blocking — sibling nav renders once data arrives
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
      pendingTitleSessions.add(targetId as string);
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
    useAgentTaskStore.getState().evictSession(id as string);
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
      // liveUsageMap/thinkingActiveMap are keyed by turnId, not sessionId — clean up
      // whichever turn this session was last streaming (if any) before it's gone.
      const lastTurnId = s.streamingMap.get(id as string)?.turnId as string | undefined;
      const usageMap = new Map(s.liveUsageMap);
      const thinking = new Map(s.thinkingActiveMap);
      if (lastTurnId) {
        usageMap.delete(lastTurnId);
        thinking.delete(lastTurnId);
      }
      return { messages: msgs, streamingMap: streaming, stopReasonMap: stops, draftMap: drafts, emotionStateMap: emotions, iterationCountMap: iterations, recallEvidenceMap: recalls, liveUsageMap: usageMap, thinkingActiveMap: thinking };
    });
  },

  // ── Stream lifecycle ─────────────────────────────────────────────────────

  beginStream(sessionId, turnId, mode) {
    set((s) => {
      const streaming = new Map(s.streamingMap);
      streaming.set(sessionId as string, {
        role: 'assistant', content: '', slices: [], startedAt: Date.now(), turnId, mode,
      });
      const stops = new Map(s.stopReasonMap);
      stops.delete(sessionId as string);
      const iterations = new Map(s.iterationCountMap);
      iterations.delete(sessionId as string);
      const recalls = new Map(s.recallEvidenceMap);
      recalls.delete(sessionId as string);
      return { streamingMap: streaming, stopReasonMap: stops, iterationCountMap: iterations, recallEvidenceMap: recalls };
    });
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

  finalizeStream(sessionId, stats) {
    set((s) => {
      const sm = s.streamingMap.get(sessionId as string);
      const streaming = new Map(s.streamingMap);
      streaming.delete(sessionId as string);

      if (!sm) return { streamingMap: streaming };

      const historyItem: ChatHistoryItem = {
        role: 'assistant', content: sm.content, slices: sm.slices,
        createdAt: Date.now(), stats: stats ?? undefined, turnId: sm.turnId, mode: sm.mode,
      };
      const msgs = new Map(s.messages);
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
      const sm = s.streamingMap.get(sessionId as string);
      const streaming = new Map(s.streamingMap);
      streaming.delete(sessionId as string);
      const stops = new Map(s.stopReasonMap);
      stops.set(sessionId as string, reason);

      if (sm && (sm.content.trim() || sm.slices.length > 0)) {
        const partial: ChatHistoryItem = {
          role: 'assistant', content: sm.content, slices: sm.slices, createdAt: sm.startedAt, turnId: sm.turnId, mode: sm.mode,
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

    // Refresh sidebar status for failed turns (not user-initiated stops).
    if (reason !== '已停止') {
      void useSessionStore.getState().loadSessions().catch(() => {});
    }
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Rebuild chronological chat history from raw DB messages + their turns.
 *
 * Grouping invariant: a "group" only ever holds ASSISTANT content. Agent turns
 * persist as multiple assistant messages (think→act→think) plus tool_results
 * user-messages — we fold them back into ONE bubble so reload looks identical
 * to streaming. User messages share the same turnId as their reply, so they
 * must NEVER open a group (or the reply would merge into the user bubble).
 */
function assembleHistory(messages: MessageWire[], turns: TurnWire[]): ChatHistoryItem[] {
  const turnById = new Map(turns.map((t) => [t.id, t]));
  // listMessages is newest-first (cursor semantics); fold in chronological order.
  const chronological = [...messages].reverse();

  const out: ChatHistoryItem[] = [];
  let currentGroup: ChatHistoryItem | null = null;

  const flush = (): void => {
    if (!currentGroup) return;
    const turn = currentGroup.turnId ? turnById.get(currentGroup.turnId as string) : undefined;
    if (turn) {
      currentGroup.stats = {
        inputTokens:  turn.usageInputTokens,
        outputTokens: turn.usageOutputTokens,
        durationMs:   turn.completedAt !== null ? turn.completedAt - turn.startedAt : 0,
      };
      currentGroup.mode = turn.mode;
    }
    out.push(currentGroup);
    currentGroup = null;
  };

  const toItem = (m: MessageWire): ChatHistoryItem => {
    const { content, slices } = blocksToHistoryFields(m.role, m.blocks);
    const item: ChatHistoryItem = {
      role:      m.role as ChatHistoryItem['role'],
      content,
      slices,
      createdAt: m.createdAt,
      messageId: m.id as MessageId,
      turnId:    m.turnId !== null ? (m.turnId as TurnId) : undefined,
    };
    if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
      item.attachments = m.attachments.map((a) => ({
        id: a.id, name: a.name, mimeType: a.mimeType,
        size: a.size ?? 0, mtime: a.mtime ?? 0, localPath: a.localPath ?? '',
      }));
    }
    return item;
  };

  for (const m of chronological) {
    if (m.kind !== 'normal' && m.kind !== 'summary' && m.kind !== 'tool_results') {
      continue;
    }

    if (m.kind === 'tool_results') {
      // Backfill tool results into the current group's tool_use slices —
      // mirrors the streaming path's appendDelta('tool_result').
      const blocks = m.blocks;
      const group = currentGroup;
      if (!Array.isArray(blocks) || !group?.slices) continue;

      // Work on a local copy so each backfill sees the previous one
      // (multiple tool results per message must not overwrite each other).
      let working = group.slices;
      for (const block of blocks as ToolResultBlock[]) {
        if (block.type !== 'tool_result') continue;
        const idx = working.findIndex(
          (s) => s.type === 'tool_use' && s.callId === block.toolUseId,
        );
        if (idx === -1) continue;
        const target = working[idx];
        if (target?.type !== 'tool_use') continue;

        const updated: AssistantSlice = {
          ...target,
          result: block.content,
          ...(block.isError
            ? { error: { code: 'tool/error', message: typeof block.content === 'string' ? block.content : '工具执行失败' } }
            : {}),
        };
        working = [...working.slice(0, idx), updated, ...working.slice(idx + 1)];
      }
      group.slices = working;
      continue;
    }

    if (m.role === 'user') {
      // User bubbles never open a group — see grouping invariant above.
      flush();
      out.push(toItem(m));
      continue;
    }

    if (m.role === 'assistant') {
      const item = toItem(m);

      if (!item.turnId) {
        // Legacy rows without turnId degrade to standalone bubbles.
        flush();
        out.push(item);
        continue;
      }

      if (currentGroup && currentGroup.turnId === item.turnId) {
        if (item.slices) {
          currentGroup.slices = [...(currentGroup.slices ?? []), ...item.slices];
        }
        if (item.content) {
          currentGroup.content = currentGroup.content
            ? currentGroup.content + '\n' + item.content
            : item.content;
        }
      } else {
        flush();
        currentGroup = item;
      }
      continue;
    }
  }

  flush();   // the last group has no successor to trigger it
  return out;
}

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
