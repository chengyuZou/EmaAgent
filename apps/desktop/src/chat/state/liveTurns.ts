import { create } from 'zustand';
import type { ContextUsage } from '@ema-agent/context';
import type { LlmTokenUsage } from '@ema-agent/llm';
import type { NarrativeEvent } from '@ema-agent/narrative';
import type { ExecutionProfile, NarrativePolicy } from '@ema-agent/session';
import type { ToolError } from '@ema-agent/tools';
import type { NarrativeStatusViewData } from '@ema-agent/builtin-tools/ui';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { useSessionStore } from '../../stores/session.js';
import { useHistoryStore } from './history.js';

export type LiveTurnItem =
  | { readonly type: 'text'; readonly blockIndex: number; readonly text: string }
  | { readonly type: 'thinking'; readonly blockIndex: number; readonly thinking: string; readonly done: boolean }
  | {
      readonly type: 'tool_use';
      readonly blockIndex: number;
      readonly callId: string;
      readonly name: string;
      readonly args?: unknown;
      readonly partialArgs?: string;
      readonly startedAt: number;
      readonly permissionPending?: boolean;
      readonly progress?: readonly unknown[];
      readonly output?: unknown;
      readonly error?: ToolError;
      readonly durationMs?: number;
    }
  | ({ readonly type: 'narrative_status'; readonly blockIndex: number } & NarrativeStatusViewData);

export interface LiveTurn {
  readonly turnId: string;
  readonly executionProfile: ExecutionProfile;
  readonly narrativePolicy: NarrativePolicy;
  readonly startedAt: number;
  readonly items: readonly LiveTurnItem[];
  readonly thinkingActive: boolean;
  readonly iteration: number | null;
}

export type ContextUsageEntry =
  | { readonly kind: 'llm_call'; readonly llmCallId: string; readonly usage: ContextUsage }
  | { readonly kind: 'manual_compact'; readonly inputTokens: number; readonly contextWindow: number };

interface LiveTurnsStore {
  readonly bySession: ReadonlyMap<string, LiveTurn>;
  readonly stopReasonBySession: ReadonlyMap<string, string>;
  readonly contextUsageBySession: Readonly<Record<string, ContextUsageEntry>>;
  readonly rootUsageByTurn: Readonly<Record<string, LlmTokenUsage>>;
  readonly stageOwnerSessionId: string | null;
  readonly emotionBySession: ReadonlyMap<string, string>;
  begin(sessionId: string, turnId: string, executionProfile: ExecutionProfile, narrativePolicy: NarrativePolicy): void;
  appendText(sessionId: string, blockIndex: number, delta: string): void;
  appendThinking(sessionId: string, blockIndex: number, delta: string): void;
  finishThinking(sessionId: string, blockIndex: number): void;
  upsertPartialTool(sessionId: string, blockIndex: number, callId: string, name: string, argsDelta: string): void;
  completeTool(sessionId: string, blockIndex: number, callId: string, name: string, args: unknown): void;
  appendToolProgress(sessionId: string, callId: string, progress: unknown): void;
  setToolResult(sessionId: string, callId: string, result: { output?: unknown; error?: ToolError; durationMs: number }): void;
  setToolPermissionPending(sessionId: string, callId: string, pending: boolean): void;
  narrativeStarted(sessionId: string): void;
  narrativeCompleted(sessionId: string, event: Extract<NarrativeEvent, { type: 'narrative_recall_completed' }>): void;
  narrativeFailed(sessionId: string, message: string): void;
  setIteration(sessionId: string, iteration: number): void;
  settle(sessionId: string, turnId: string): void;
  abort(sessionId: string, turnId: string, reason: string): void;
  applyContextUsage(sessionId: string, llmCallId: string, usage: ContextUsage): void;
  applyManualCompact(sessionId: string, inputTokens: number, contextWindow: number): void;
  setRootUsage(turnId: string, usage: LlmTokenUsage): void;
  clearTurnUsage(turnId: string): void;
  claimStageOwner(sessionId: string): void;
  setEmotion(sessionId: string, emotion: string): void;
  clearEmotions(): void;
  evictSession(sessionId: string): void;
}

const MAX_TOOL_PROGRESS_EVENTS = 200;

function patchLiveTurns(
  turns: ReadonlyMap<string, LiveTurn>,
  sessionId: string,
  update: (turn: LiveTurn) => LiveTurn,
): ReadonlyMap<string, LiveTurn> {
  const current = turns.get(sessionId);
  if (!current) return turns;
  return new Map(turns).set(sessionId, update(current));
}

function upsertItem(
  items: readonly LiveTurnItem[],
  blockIndex: number,
  create: () => LiveTurnItem,
  update: (item: LiveTurnItem) => LiveTurnItem,
): LiveTurnItem[] {
  const index = items.findIndex(item => item.blockIndex === blockIndex);
  if (index < 0) return [...items, create()].sort((left, right) => left.blockIndex - right.blockIndex);
  return items.map((item, itemIndex) => itemIndex === index ? update(item) : item);
}

export const useLiveTurns = create<LiveTurnsStore>((set, get) => ({
  bySession: new Map(),
  stopReasonBySession: new Map(),
  contextUsageBySession: {},
  rootUsageByTurn: {},
  stageOwnerSessionId: null,
  emotionBySession: new Map(),

  begin(sessionId, turnId, executionProfile, narrativePolicy) {
    set(state => ({
      bySession: new Map(state.bySession).set(sessionId, {
        turnId,
        executionProfile,
        narrativePolicy,
        startedAt: Date.now(),
        items: [],
        thinkingActive: false,
        iteration: null,
      }),
      stopReasonBySession: new Map([...state.stopReasonBySession].filter(([id]) => id !== sessionId)),
    }));
  },
  appendText(sessionId, blockIndex, delta) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        items: upsertItem(
          turn.items,
          blockIndex,
          () => ({ type: 'text', blockIndex, text: delta }),
          (item) => item.type === 'text'
            ? { ...item, text: item.text + delta }
            : item,
        ),
      })),
    }));
  },
  appendThinking(sessionId, blockIndex, delta) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        thinkingActive: true,
        items: upsertItem(
          turn.items,
          blockIndex,
          () => ({ type: 'thinking', blockIndex, thinking: delta, done: false }),
          (item) => item.type === 'thinking'
            ? { ...item, thinking: item.thinking + delta }
            : item,
        ),
      })),
    }));
  },
  finishThinking(sessionId, blockIndex) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        thinkingActive: false,
        items: turn.items.map((item) => (
          item.type === 'thinking' && item.blockIndex === blockIndex
            ? { ...item, done: true }
            : item
        )),
      })),
    }));
  },
  upsertPartialTool(sessionId, blockIndex, callId, name, argsDelta) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        items: upsertItem(
          turn.items,
          blockIndex,
          () => ({
            type: 'tool_use',
            blockIndex,
            callId,
            name,
            partialArgs: argsDelta,
            startedAt: Date.now(),
          }),
          (item) => item.type === 'tool_use'
            ? { ...item, partialArgs: (item.partialArgs ?? '') + argsDelta }
            : item,
        ),
      })),
    }));
  },
  completeTool(sessionId, blockIndex, callId, name, args) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        items: upsertItem(
          turn.items,
          blockIndex,
          () => ({ type: 'tool_use', blockIndex, callId, name, args, startedAt: Date.now() }),
          (item) => ({
            type: 'tool_use',
            blockIndex,
            callId,
            name,
            args,
            startedAt: item.type === 'tool_use' ? item.startedAt : Date.now(),
          }),
        ),
      })),
    }));
  },
  appendToolProgress(sessionId, callId, progress) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        items: turn.items.map((item) => (
          item.type === 'tool_use' && item.callId === callId
            ? { ...item, progress: [...(item.progress ?? []), progress].slice(-MAX_TOOL_PROGRESS_EVENTS) }
            : item
        )),
      })),
    }));
  },
  setToolResult(sessionId, callId, result) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        items: turn.items.map((item) => (
          item.type === 'tool_use' && item.callId === callId
            ? { ...item, ...result, permissionPending: undefined, progress: undefined }
            : item
        )),
      })),
    }));
  },
  setToolPermissionPending(sessionId, callId, pending) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        items: turn.items.map((item) => (
          item.type === 'tool_use' && item.callId === callId
            ? { ...item, permissionPending: pending || undefined }
            : item
        )),
      })),
    }));
  },
  narrativeStarted(sessionId) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        items: [
          ...turn.items.filter((item) => item.type !== 'narrative_status'),
          {
            type: 'narrative_status',
            blockIndex: Number.MAX_SAFE_INTEGER,
            status: 'running',
            timelines: [],
            completedTimelines: [],
            snippets: {},
            failedTimelines: {},
          },
        ],
      })),
    }));
  },
  narrativeCompleted(sessionId, event) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        items: [
          ...turn.items.filter((item) => item.type !== 'narrative_status'),
          {
            type: 'narrative_status',
            blockIndex: Number.MAX_SAFE_INTEGER,
            status: 'completed',
            timelines: [...event.timelineOrder],
            completedTimelines: event.timelines.map((item) => item.name),
            snippets: Object.fromEntries(
              event.timelines.map((item) => [item.name, item.snippet]),
            ),
            failedTimelines: Object.fromEntries(
              event.failures.map((item) => [item.timeline, item.message]),
            ),
          },
        ],
      })),
    }));
  },
  narrativeFailed(sessionId, message) {
    set((state) => ({
      bySession: patchLiveTurns(state.bySession, sessionId, (turn) => ({
        ...turn,
        items: [
          ...turn.items.filter((item) => item.type !== 'narrative_status'),
          {
            type: 'narrative_status',
            blockIndex: Number.MAX_SAFE_INTEGER,
            status: 'failed',
            timelines: [],
            completedTimelines: [],
            snippets: {},
            failedTimelines: {},
            message,
          },
        ],
      })),
    }));
  },
  setIteration(sessionId, iteration) {
    set(state => ({ bySession: patchLiveTurns(state.bySession, sessionId, turn => ({ ...turn, iteration })) }));
  },

  settle(sessionId, turnId) {
    void useHistoryStore.getState().mergeTurnMessages(sessionId, turnId).finally(() => set(state => {
      const bySession = new Map(state.bySession);
      if (bySession.get(sessionId)?.turnId === turnId) bySession.delete(sessionId);
      return { bySession };
    }));
    useHistoryStore.getState().invalidateTurnIndex(sessionId);
    void useSessionStore.getState().loadSessions();
  },
  abort(sessionId, turnId, reason) {
    void useHistoryStore.getState().mergeTurnMessages(sessionId, turnId).catch(() => {}).finally(() => set(state => {
      const bySession = new Map(state.bySession);
      if (bySession.get(sessionId)?.turnId === turnId) bySession.delete(sessionId);
      return { bySession };
    }));
    set(state => ({ stopReasonBySession: new Map(state.stopReasonBySession).set(sessionId, reason) }));
    setTimeout(() => set(state => { const reasons = new Map(state.stopReasonBySession); reasons.delete(sessionId); return { stopReasonBySession: reasons }; }), 3000);
    useHistoryStore.getState().invalidateTurnIndex(sessionId);
  },

  applyContextUsage(sessionId, llmCallId, usage) {
    set(state => {
      const current = state.contextUsageBySession[sessionId];
      // Provider 校正只属于同一次 LLM 调用;迟到的旧校正不能覆盖新调用的估算值.
      if (current?.kind === 'llm_call' && current.llmCallId !== llmCallId && usage.source === 'provider') return state;
      return { contextUsageBySession: { ...state.contextUsageBySession, [sessionId]: { kind: 'llm_call', llmCallId, usage } } };
    });
  },
  applyManualCompact(sessionId, inputTokens, contextWindow) {
    set(state => ({ contextUsageBySession: { ...state.contextUsageBySession, [sessionId]: { kind: 'manual_compact', inputTokens, contextWindow } } }));
  },
  setRootUsage(turnId, usage) {
    set(state => ({ rootUsageByTurn: { ...state.rootUsageByTurn, [turnId]: usage } }));
  },
  clearTurnUsage(turnId) {
    set(state => {
      const rootUsageByTurn = { ...state.rootUsageByTurn };
      delete rootUsageByTurn[turnId];
      return { rootUsageByTurn };
    });
  },

  claimStageOwner(sessionId) {
    if (get().stageOwnerSessionId === sessionId) return;
    set({ stageOwnerSessionId: sessionId });
    const emotion = get().emotionBySession.get(sessionId);
    if (emotion) void tauriBridge.publishStageEmotion(emotion);
  },
  setEmotion(sessionId, emotion) {
    set(state => ({ emotionBySession: new Map(state.emotionBySession).set(sessionId, emotion) }));
    if (get().stageOwnerSessionId === sessionId) void tauriBridge.publishStageEmotion(emotion);
  },
  clearEmotions() { set({ emotionBySession: new Map() }); },

  evictSession(sessionId) {
    set(state => {
      const bySession = new Map(state.bySession); bySession.delete(sessionId);
      const stopReasonBySession = new Map(state.stopReasonBySession); stopReasonBySession.delete(sessionId);
      const emotionBySession = new Map(state.emotionBySession); emotionBySession.delete(sessionId);
      const contextUsageBySession = { ...state.contextUsageBySession }; delete contextUsageBySession[sessionId];
      return {
        bySession,
        stopReasonBySession,
        emotionBySession,
        contextUsageBySession,
        stageOwnerSessionId: state.stageOwnerSessionId === sessionId ? null : state.stageOwnerSessionId,
      };
    });
  },
}));

export function sumTurnUsage(state: Pick<LiveTurnsStore, 'rootUsageByTurn'>, turnId: string): LlmTokenUsage | undefined {
  return state.rootUsageByTurn[turnId];
}
