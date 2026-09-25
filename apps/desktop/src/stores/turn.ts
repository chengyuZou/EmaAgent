// 保存尚未交给 History 的 Turn 及其屏幕消息顺序.

import { create } from 'zustand';
import type { ContextUsage } from '@ema-agent/context';
import type { LlmTokenUsage } from '@ema-agent/llm';
import type {
  SessionMessage,
  NarrativePolicy,
  SessionMode,
} from '@ema-agent/session';
import type { TurnStreamEvent } from '@ema-agent/turn';
import type { ToolError } from '@ema-agent/tools';

export type TurnStoreEvent = Exclude<TurnStreamEvent, {
  readonly type: 'user_message_stored';
}>;

export type AssistantOutputBlock =
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
      readonly status: 'running' | 'awaiting_permission' | 'succeeded' | 'failed' | 'interrupted' | 'outcome_unknown';
    };

/** 当前 Turn 中尚未形成持久 Assistant Message 的一条屏幕消息. */
export interface StreamingMessage {
  readonly type: 'streaming';
  readonly id: string;
  readonly turnId: string;
  readonly blocks: readonly AssistantOutputBlock[];
  readonly createdAt: number;
}

export interface TurnState {
  readonly turnId: string;
  readonly sessionMode: SessionMode;
  readonly narrativePolicy: NarrativePolicy;
  readonly startedAt: number;
  /** 已确认 Message 与流式 Assistant Message 共用这一份屏幕顺序. */
  readonly messages: readonly (SessionMessage | StreamingMessage)[];
  readonly thinkingActive: boolean;
  readonly iteration: number | null;
  /** Server 已结束这一轮, 但 History 成功接管前仍保留屏幕内容. */
  readonly terminal: boolean;
}

export type ContextUsageEntry = {
  readonly kind: 'llm_call';
  readonly llmCallId: string;
  readonly usage: ContextUsage;
};

interface TurnStore {
  /** 每个 Session 内按 turn_started 到达顺序保存尚未被 History 接管的 Turn. */
  readonly turnsBySession: ReadonlyMap<string, ReadonlyMap<string, TurnState>>;
  readonly stopReasonBySession: ReadonlyMap<string, string>;
  readonly contextUsageBySession: Readonly<Record<string, ContextUsageEntry>>;
  readonly contextEstimateVersionBySession: Readonly<Record<string, number>>;
  readonly rootUsageByTurn: Readonly<Record<string, LlmTokenUsage>>;
  receiveTurnEvent(sessionId: string, turnId: string, event: TurnStoreEvent): void;
  restore(
    sessionId: string,
    turnId: string,
    createdAt: number,
    sessionMode: SessionMode,
    narrativePolicy: NarrativePolicy,
    messages: readonly SessionMessage[],
  ): void;
  begin(
    sessionId: string,
    turnId: string,
    sessionMode: SessionMode,
    narrativePolicy: NarrativePolicy,
  ): void;
  /** 返回 false 表示消息不属于当前 Turn, 调用方应直接交给 History. */
  receiveUserMessage(sessionId: string, message: SessionMessage): boolean;
  appendText(sessionId: string, turnId: string, blockIndex: number, delta: string): void;
  appendThinking(sessionId: string, turnId: string, blockIndex: number, delta: string): void;
  finishThinking(sessionId: string, turnId: string, blockIndex: number): void;
  upsertPartialTool(
    sessionId: string,
    turnId: string,
    blockIndex: number,
    callId: string,
    name: string,
    argsDelta: string,
  ): void;
  completeTool(
    sessionId: string,
    turnId: string,
    blockIndex: number,
    callId: string,
    name: string,
    args: unknown,
  ): void;
  appendToolProgress(sessionId: string, turnId: string, callId: string, progress: unknown): void;
  setToolResult(
    sessionId: string,
    turnId: string,
    callId: string,
    result: { output?: unknown; error?: ToolError; durationMs: number },
  ): void;
  setToolPermissionPending(sessionId: string, turnId: string, callId: string, pending: boolean): void;
  setIteration(sessionId: string, turnId: string, iteration: number): void;
  markTerminal(sessionId: string, turnId: string, reason?: string): void;
  removeTurn(sessionId: string, turnId: string): void;
  applyContextUsage(sessionId: string, llmCallId: string, usage: ContextUsage): void;
  invalidateContextUsage(sessionId: string): void;
  setRootUsage(turnId: string, usage: LlmTokenUsage): void;
  clearTurnUsage(turnId: string): void;
  evictSession(sessionId: string): void;
}

const MAX_TOOL_PROGRESS_EVENTS = 200;
let nextStreamingMessageSequence = 0;

export function isStreamingMessage(
  message: SessionMessage | StreamingMessage,
): message is StreamingMessage {
  return 'type' in message && message.type === 'streaming';
}

function patchTurnState(
  turnsBySession: ReadonlyMap<string, ReadonlyMap<string, TurnState>>,
  sessionId: string,
  turnId: string,
  update: (turn: TurnState) => TurnState,
): ReadonlyMap<string, ReadonlyMap<string, TurnState>> {
  const turns = turnsBySession.get(sessionId);
  const current = turns?.get(turnId);
  if (!turns || !current) return turnsBySession;
  const nextTurns = new Map(turns);
  nextTurns.set(turnId, update(current));
  return new Map(turnsBySession).set(sessionId, nextTurns);
}

function upsertBlock(
  blocks: readonly AssistantOutputBlock[],
  blockIndex: number,
  create: () => AssistantOutputBlock,
  update: (item: AssistantOutputBlock) => AssistantOutputBlock,
): AssistantOutputBlock[] {
  const index = blocks.findIndex(item => item.blockIndex === blockIndex);
  if (index < 0) {
    return [...blocks, create()].sort((left, right) => left.blockIndex - right.blockIndex);
  }
  return blocks.map((item, itemIndex) => itemIndex === index ? update(item) : item);
}

function createStreamingMessage(turn: TurnState): StreamingMessage {
  return {
    type: 'streaming',
    id: `streaming:${turn.turnId}:${nextStreamingMessageSequence++}`,
    turnId: turn.turnId,
    blocks: [],
    createdAt: Date.now(),
  };
}

function patchCurrentStreamingMessage(
  turn: TurnState,
  update: (blocks: readonly AssistantOutputBlock[]) => readonly AssistantOutputBlock[],
): TurnState {
  const messages = [...turn.messages];
  const last = messages.at(-1);
  if (last && isStreamingMessage(last)) {
    messages[messages.length - 1] = { ...last, blocks: update(last.blocks) };
  } else {
    const message = createStreamingMessage(turn);
    messages.push({ ...message, blocks: update(message.blocks) });
  }
  return { ...turn, messages };
}

function appendPersistedMessage(turn: TurnState, message: SessionMessage): TurnState {
  if (turn.messages.some(item => !isStreamingMessage(item) && item.id === message.id)) return turn;
  const messages = [...turn.messages];
  const last = messages.at(-1);
  // agent_iteration 可以先建立空 Assistant 消息. 第一条 UserMessage 到达时不在它前面留空行.
  if (last && isStreamingMessage(last) && last.blocks.length === 0) messages.pop();
  messages.push(message);
  return { ...turn, messages };
}

function patchToolByCallId(
  turn: TurnState,
  callId: string,
  update: (item: Extract<AssistantOutputBlock, { type: 'tool_use' }>) => AssistantOutputBlock,
): TurnState {
  return {
    ...turn,
    messages: turn.messages.map(message => isStreamingMessage(message)
      ? {
          ...message,
          blocks: message.blocks.map(item => (
            item.type === 'tool_use' && item.callId === callId ? update(item) : item
          )),
        }
      : message),
  };
}

function interruptUnresolvedTools(turn: TurnState): TurnState {
  return {
    ...turn,
    messages: turn.messages.map(message => isStreamingMessage(message)
      ? {
          ...message,
          blocks: message.blocks.map(item => (
            item.type === 'tool_use'
            && (item.status === 'running' || item.status === 'awaiting_permission')
              ? {
                  ...item,
                  status: 'interrupted' as const,
                  permissionPending: undefined,
                  progress: undefined,
                  error: item.error ?? {
                    code: 'tool/cancelled',
                    message: 'Turn 已结束，工具调用未产生结果',
                  },
                }
              : item
          )),
        }
      : message),
  };
}

function finishTurnMessages(turn: TurnState): TurnState {
  const interrupted = interruptUnresolvedTools(turn);
  const messages = [...interrupted.messages];
  const last = messages.at(-1);
  if (last && isStreamingMessage(last) && last.blocks.length === 0) messages.pop();
  return {
    ...interrupted,
    messages,
    terminal: true,
    thinkingActive: false,
  };
}

export function assistantOutputBlocks(turn: TurnState | undefined): readonly AssistantOutputBlock[] {
  return turn?.messages.flatMap(message => isStreamingMessage(message) ? message.blocks : []) ?? [];
}

type BufferedDelta = Extract<TurnStreamEvent, {
  type: 'output_text_delta' | 'reasoning_delta' | 'tool_call_partial';
}>;

// 每条 Turn 保存最近 50ms 尚未交给 Zustand 的正文, Thinking 和 Tool 参数片段.
// Tool 完成, Thinking 完成和 terminal 等语义边界会先 flush, 因此不会越过前面的 delta.
const bufferedDeltas = new Map<string, Map<string, BufferedDelta[]>>();
const deltaTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

function turnMapValue<T>(
  map: Map<string, Map<string, T>>,
  sessionId: string,
  turnId: string,
): T | undefined {
  return map.get(sessionId)?.get(turnId);
}

function setTurnMapValue<T>(
  map: Map<string, Map<string, T>>,
  sessionId: string,
  turnId: string,
  value: T,
): void {
  const turns = map.get(sessionId) ?? new Map<string, T>();
  turns.set(turnId, value);
  map.set(sessionId, turns);
}

function deleteTurnMapValue<T>(
  map: Map<string, Map<string, T>>,
  sessionId: string,
  turnId: string,
): void {
  const turns = map.get(sessionId);
  if (!turns) return;
  turns.delete(turnId);
  if (turns.size === 0) map.delete(sessionId);
}

function applyBufferedDelta(turn: TurnState, event: BufferedDelta): TurnState {
  if (event.type === 'output_text_delta') {
    return patchCurrentStreamingMessage(turn, blocks => upsertBlock(
      blocks,
      event.blockIndex,
      () => ({ type: 'text', blockIndex: event.blockIndex, text: event.delta }),
      item => item.type === 'text' ? { ...item, text: item.text + event.delta } : item,
    ));
  }
  if (event.type === 'reasoning_delta') {
    return {
      ...patchCurrentStreamingMessage(turn, blocks => upsertBlock(
        blocks,
        event.blockIndex,
        () => ({ type: 'thinking', blockIndex: event.blockIndex, thinking: event.delta, done: false }),
        item => item.type === 'thinking'
          ? { ...item, thinking: item.thinking + event.delta }
          : item,
      )),
      thinkingActive: true,
    };
  }
  return patchCurrentStreamingMessage(turn, blocks => upsertBlock(
    blocks,
    event.blockIndex,
    () => ({
      type: 'tool_use',
      blockIndex: event.blockIndex,
      callId: event.callId,
      name: event.name,
      partialArgs: event.argsDelta,
      startedAt: Date.now(),
      status: 'running',
    }),
    item => item.type === 'tool_use'
      ? { ...item, partialArgs: (item.partialArgs ?? '') + event.argsDelta }
      : item,
  ));
}

function flushBufferedDeltas(sessionId: string, turnId: string): void {
  const events = turnMapValue(bufferedDeltas, sessionId, turnId);
  if (!events?.length) return;
  deleteTurnMapValue(bufferedDeltas, sessionId, turnId);
  const timer = turnMapValue(deltaTimers, sessionId, turnId);
  if (timer) clearTimeout(timer);
  deleteTurnMapValue(deltaTimers, sessionId, turnId);
  useTurnStore.setState(state => ({
    turnsBySession: patchTurnState(state.turnsBySession, sessionId, turnId, turn => (
      events.reduce(applyBufferedDelta, turn)
    )),
  }));
}

function bufferDelta(sessionId: string, turnId: string, event: BufferedDelta): void {
  setTurnMapValue(bufferedDeltas, sessionId, turnId, [
    ...(turnMapValue(bufferedDeltas, sessionId, turnId) ?? []),
    event,
  ]);
  if (turnMapValue(deltaTimers, sessionId, turnId)) return;
  setTurnMapValue(deltaTimers, sessionId, turnId, setTimeout(() => {
    flushBufferedDeltas(sessionId, turnId);
  }, 50));
}

function discardBufferedDeltas(sessionId: string, turnId: string): void {
  const timer = turnMapValue(deltaTimers, sessionId, turnId);
  if (timer) clearTimeout(timer);
  deleteTurnMapValue(deltaTimers, sessionId, turnId);
  deleteTurnMapValue(bufferedDeltas, sessionId, turnId);
}

export const useTurnStore = create<TurnStore>((set, get) => ({
  turnsBySession: new Map(),
  stopReasonBySession: new Map(),
  contextUsageBySession: {},
  contextEstimateVersionBySession: {},
  rootUsageByTurn: {},

  receiveTurnEvent(sessionId, turnId, event) {
    if (
      event.type === 'output_text_delta'
      || event.type === 'reasoning_delta'
      || event.type === 'tool_call_partial'
    ) {
      bufferDelta(sessionId, turnId, event);
      return;
    }
    flushBufferedDeltas(sessionId, turnId);
    const turnStore = get();
    switch (event.type) {
      case 'turn_started':
        turnStore.begin(sessionId, turnId, event.sessionMode, event.narrativePolicy);
        return;
      case 'agent_iteration':
        turnStore.setIteration(sessionId, turnId, event.n);
        return;
      case 'reasoning_complete':
        turnStore.finishThinking(sessionId, turnId, event.blockIndex);
        return;
      case 'tool_call_complete':
        turnStore.completeTool(sessionId, turnId, event.blockIndex, event.callId, event.name, event.args);
        return;
      case 'tool_progress':
        turnStore.appendToolProgress(sessionId, turnId, event.callId, event.progress);
        return;
      case 'tool_result':
        turnStore.setToolResult(sessionId, turnId, event.callId, {
          ...(event.output !== undefined ? { output: event.output } : {}),
          ...(event.error ? { error: event.error } : {}),
          durationMs: event.durationMs,
        });
        return;
      case 'permission_required':
        turnStore.setToolPermissionPending(sessionId, turnId, event.toolCallId, true);
        return;
      case 'permission_resolved':
        turnStore.setToolPermissionPending(sessionId, turnId, event.toolCallId, false);
        return;
      case 'context_usage_updated':
        turnStore.applyContextUsage(sessionId, event.llmCallId, event.usage);
        return;
      case 'agent_usage_updated':
        turnStore.setRootUsage(turnId, event.usage);
        return;
      case 'narrative_recall_started':
      case 'narrative_recall_completed':
      case 'narrative_recall_failed':
        return;
      case 'turn_completed':
        turnStore.markTerminal(sessionId, turnId);
        return;
      case 'turn_failed':
      case 'turn_aborted':
        turnStore.markTerminal(
          sessionId,
          turnId,
          event.type === 'turn_failed' ? event.message : event.reason,
        );
        return;
      case 'motion_changed':
      case 'emotion_changed':
      case 'ask_user_required':
      case 'ask_user_resolved':
      case 'compact_started':
      case 'compact_completed':
      case 'compact_cancelled':
      case 'compact_failed':
      case 'request_degraded':
      case 'turn_projection_warning':
        return;
      default:
        event satisfies never;
    }
  },

  restore(sessionId, turnId, createdAt, sessionMode, narrativePolicy, messages) {
    discardBufferedDeltas(sessionId, turnId);
    set(state => {
      const turns = new Map(state.turnsBySession.get(sessionId) ?? []);
      turns.set(turnId, {
        turnId,
        sessionMode,
        narrativePolicy,
        startedAt: createdAt,
        messages: [...messages],
        thinkingActive: false,
        iteration: null,
        terminal: false,
      });
      return { turnsBySession: new Map(state.turnsBySession).set(sessionId, turns) };
    });
  },

  begin(sessionId, turnId, sessionMode, narrativePolicy) {
    set(state => {
      const currentTurns = state.turnsBySession.get(sessionId);
      if (currentTurns?.has(turnId)) return state;
      const turns = new Map(currentTurns ?? []);
      turns.set(turnId, {
        turnId,
        sessionMode,
        narrativePolicy,
        startedAt: Date.now(),
        messages: [],
        thinkingActive: false,
        iteration: null,
        terminal: false,
      });
      return {
        turnsBySession: new Map(state.turnsBySession).set(sessionId, turns),
        stopReasonBySession: new Map([...state.stopReasonBySession].filter(([id]) => id !== sessionId)),
      };
    });
  },

  receiveUserMessage(sessionId, message) {
    if (!message.turnId || !get().turnsBySession.get(sessionId)?.has(message.turnId)) return false;
    set(state => ({
      turnsBySession: patchTurnState(
        state.turnsBySession,
        sessionId,
        message.turnId!,
        turn => appendPersistedMessage(turn, message),
      ),
    }));
    return true;
  },

  appendText(sessionId, turnId, blockIndex, delta) {
    set(state => ({
      turnsBySession: patchTurnState(state.turnsBySession, sessionId, turnId, turn => (
        patchCurrentStreamingMessage(turn, blocks => upsertBlock(
          blocks,
          blockIndex,
          () => ({ type: 'text', blockIndex, text: delta }),
          item => item.type === 'text' ? { ...item, text: item.text + delta } : item,
        ))
      )),
    }));
  },

  appendThinking(sessionId, turnId, blockIndex, delta) {
    set(state => ({
      turnsBySession: patchTurnState(state.turnsBySession, sessionId, turnId, turn => ({
        ...patchCurrentStreamingMessage(turn, blocks => upsertBlock(
          blocks,
          blockIndex,
          () => ({ type: 'thinking', blockIndex, thinking: delta, done: false }),
          item => item.type === 'thinking'
            ? { ...item, thinking: item.thinking + delta }
            : item,
        )),
        thinkingActive: true,
      })),
    }));
  },

  finishThinking(sessionId, turnId, blockIndex) {
    set(state => ({
      turnsBySession: patchTurnState(state.turnsBySession, sessionId, turnId, turn => ({
        ...patchCurrentStreamingMessage(turn, blocks => blocks.map(item => (
          item.type === 'thinking' && item.blockIndex === blockIndex
            ? { ...item, done: true }
            : item
        ))),
        thinkingActive: false,
      })),
    }));
  },

  upsertPartialTool(sessionId, turnId, blockIndex, callId, name, argsDelta) {
    set(state => ({
      turnsBySession: patchTurnState(state.turnsBySession, sessionId, turnId, turn => (
        patchCurrentStreamingMessage(turn, blocks => upsertBlock(
          blocks,
          blockIndex,
          () => ({
            type: 'tool_use',
            blockIndex,
            callId,
            name,
            partialArgs: argsDelta,
            startedAt: Date.now(),
            status: 'running',
          }),
          item => item.type === 'tool_use'
            ? { ...item, partialArgs: (item.partialArgs ?? '') + argsDelta }
            : item,
        ))
      )),
    }));
  },

  completeTool(sessionId, turnId, blockIndex, callId, name, args) {
    set(state => ({
      turnsBySession: patchTurnState(state.turnsBySession, sessionId, turnId, turn => (
        patchCurrentStreamingMessage(turn, blocks => upsertBlock(
          blocks,
          blockIndex,
          () => ({
            type: 'tool_use',
            blockIndex,
            callId,
            name,
            args,
            startedAt: Date.now(),
            status: 'running',
          }),
          item => ({
            type: 'tool_use',
            blockIndex,
            callId,
            name,
            args,
            startedAt: item.type === 'tool_use' ? item.startedAt : Date.now(),
            status: 'running',
          }),
        ))
      )),
    }));
  },

  appendToolProgress(sessionId, turnId, callId, progress) {
    set(state => ({
      turnsBySession: patchTurnState(state.turnsBySession, sessionId, turnId, turn => (
        patchToolByCallId(turn, callId, item => ({
          ...item,
          progress: [...(item.progress ?? []), progress].slice(-MAX_TOOL_PROGRESS_EVENTS),
        }))
      )),
    }));
  },

  setToolResult(sessionId, turnId, callId, result) {
    set(state => ({
      turnsBySession: patchTurnState(state.turnsBySession, sessionId, turnId, turn => (
        patchToolByCallId(turn, callId, item => ({
          ...item,
          ...result,
          status: result.error ? 'failed' : 'succeeded',
          permissionPending: undefined,
          progress: undefined,
        }))
      )),
    }));
  },

  setToolPermissionPending(sessionId, turnId, callId, pending) {
    set(state => ({
      turnsBySession: patchTurnState(state.turnsBySession, sessionId, turnId, turn => (
        patchToolByCallId(turn, callId, item => ({
          ...item,
          permissionPending: pending || undefined,
          status: pending ? 'awaiting_permission' : 'running',
        }))
      )),
    }));
  },

  setIteration(sessionId, turnId, iteration) {
    set(state => ({
      turnsBySession: patchTurnState(state.turnsBySession, sessionId, turnId, turn => {
        const messages = [...turn.messages];
        const current = messages.at(-1);
        if (turn.iteration !== iteration || !current || !isStreamingMessage(current)) {
          messages.push(createStreamingMessage(turn));
        }
        return { ...turn, iteration, messages, thinkingActive: false };
      }),
    }));
  },

  markTerminal(sessionId, turnId, reason) {
    flushBufferedDeltas(sessionId, turnId);
    set(state => ({
      turnsBySession: patchTurnState(
        state.turnsBySession,
        sessionId,
        turnId,
        finishTurnMessages,
      ),
    }));
    get().clearTurnUsage(turnId);
    if (!reason) return;
    set(state => ({
      stopReasonBySession: new Map(state.stopReasonBySession).set(sessionId, reason),
    }));
    setTimeout(() => set(state => {
      const reasons = new Map(state.stopReasonBySession);
      reasons.delete(sessionId);
      return { stopReasonBySession: reasons };
    }), 3000);
  },

  removeTurn(sessionId, turnId) {
    set(state => {
      const current = state.turnsBySession.get(sessionId);
      if (!current?.has(turnId)) return state;
      const turns = new Map(current);
      turns.delete(turnId);
      const turnsBySession = new Map(state.turnsBySession);
      if (turns.size > 0) turnsBySession.set(sessionId, turns);
      else turnsBySession.delete(sessionId);
      return { turnsBySession };
    });
  },

  applyContextUsage(sessionId, llmCallId, usage) {
    set(state => {
      const current = state.contextUsageBySession[sessionId];
      if (
        current?.kind === 'llm_call'
        && current.llmCallId !== llmCallId
        && usage.source === 'provider'
      ) return state;
      return {
        contextUsageBySession: {
          ...state.contextUsageBySession,
          [sessionId]: { kind: 'llm_call', llmCallId, usage },
        },
      };
    });
  },

  invalidateContextUsage(sessionId) {
    set(state => {
      const contextUsageBySession = { ...state.contextUsageBySession };
      delete contextUsageBySession[sessionId];
      return {
        contextUsageBySession,
        contextEstimateVersionBySession: {
          ...state.contextEstimateVersionBySession,
          [sessionId]: (state.contextEstimateVersionBySession[sessionId] ?? 0) + 1,
        },
      };
    });
  },

  setRootUsage(turnId, usage) {
    set(state => ({
      rootUsageByTurn: {
        ...state.rootUsageByTurn,
        [turnId]: usage,
      },
    }));
  },

  clearTurnUsage(turnId) {
    set(state => {
      const rootUsageByTurn = { ...state.rootUsageByTurn };
      delete rootUsageByTurn[turnId];
      return { rootUsageByTurn };
    });
  },

  evictSession(sessionId) {
    for (const timer of deltaTimers.get(sessionId)?.values() ?? []) clearTimeout(timer);
    deltaTimers.delete(sessionId);
    bufferedDeltas.delete(sessionId);
    set(state => {
      const turnsBySession = new Map(state.turnsBySession);
      turnsBySession.delete(sessionId);
      const stopReasonBySession = new Map(state.stopReasonBySession);
      stopReasonBySession.delete(sessionId);
      const contextUsageBySession = { ...state.contextUsageBySession };
      delete contextUsageBySession[sessionId];
      const contextEstimateVersionBySession = { ...state.contextEstimateVersionBySession };
      delete contextEstimateVersionBySession[sessionId];
      return {
        turnsBySession,
        stopReasonBySession,
        contextUsageBySession,
        contextEstimateVersionBySession,
      };
    });
  },
}));

export function sumTurnUsage(
  state: Pick<TurnStore, 'rootUsageByTurn'>,
  turnId: string,
): LlmTokenUsage | undefined {
  return state.rootUsageByTurn[turnId];
}
