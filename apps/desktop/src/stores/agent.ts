// 持有每个 Session 的实时 Agent 状态，并把高频 Turn 增量交给新 Chat 架构消费。
import type { PermissionResponse } from '@ema-agent/permission';
import type { ActiveSessionExecution } from '@ema-agent/session';
import type { PendingInteraction, TurnStreamEvent } from '@ema-agent/turn';
import { create } from 'zustand';
import type {
  AgentServerMessage,
  StartTurnPayload,
} from '@ema-agent/server/routes/ws/agent.js';
import {
  agentWebSocket,
  type AgentConnectionState,
} from '../api/websocket.js';

export interface AgentSessionState {
  readonly connection: AgentConnectionState;
  readonly execution: ActiveSessionExecution | null;
  readonly pendingInteractions: readonly PendingInteraction[];
}

export type TurnEventListener = (turnId: string, event: TurnStreamEvent) => void;
type CommandCompactResult = Extract<
  AgentServerMessage,
  { type: 'compaction_completed' }
>['result'];

interface AgentStore {
  readonly sessions: ReadonlyMap<string, AgentSessionState>;
  connectSession(sessionId: string): void;
  disconnectSession(sessionId: string): void;
  startTurn(sessionId: string, payload: StartTurnPayload): Promise<string>;
  startCompaction(sessionId: string): Promise<CommandCompactResult>;
  cancelExecution(sessionId: string): Promise<void>;
  cancelTool(sessionId: string, turnId: string, toolCallId: string): Promise<void>;
  respondPermission(
    sessionId: string,
    turnId: string,
    toolCallId: string,
    response: PermissionResponse,
  ): Promise<void>;
  respondAskUser(
    sessionId: string,
    turnId: string,
    toolCallId: string,
    answers: Record<string, string>,
  ): Promise<void>;
  cancelAskUser(sessionId: string, turnId: string, toolCallId: string): Promise<void>;
}

const connectionSubscriptions = new Map<string, () => void>();
const turnEventListeners = new Map<string, Set<TurnEventListener>>();

function emptySessionState(): AgentSessionState {
  return {
    connection: 'disconnected',
    execution: null,
    pendingInteractions: [],
  };
}

function updateSession(
  sessions: ReadonlyMap<string, AgentSessionState>,
  sessionId: string,
  update: (current: AgentSessionState) => AgentSessionState,
): ReadonlyMap<string, AgentSessionState> {
  const next = new Map(sessions);
  next.set(sessionId, update(sessions.get(sessionId) ?? emptySessionState()));
  return next;
}

function removePending(
  pending: readonly PendingInteraction[],
  toolCallId: string,
): readonly PendingInteraction[] {
  return pending.filter(item => item.request.toolCallId !== toolCallId);
}

function appendPending(
  pending: readonly PendingInteraction[],
  interaction: PendingInteraction,
): readonly PendingInteraction[] {
  return [
    ...removePending(pending, interaction.request.toolCallId),
    interaction,
  ];
}

function permissionInteraction(
  event: Extract<TurnStreamEvent, { type: 'permission_required' }>,
): PendingInteraction {
  return {
    kind: 'permission',
    toolCallId: event.toolCallId,
    createdAt: Date.now(),
    request: {
      toolName: event.toolName,
      ...(event.toolDescription ? { toolDescription: event.toolDescription } : {}),
      input: event.input,
      ...(event.decisionReason ? { decisionReason: event.decisionReason } : {}),
      ...(event.ruleSuggestion ? { ruleSuggestion: event.ruleSuggestion } : {}),
      sessionId: event.sessionId,
      turnId: event.turnId,
      toolCallId: event.toolCallId,
    },
  };
}

function applyTurnEvent(
  current: AgentSessionState,
  event: TurnStreamEvent,
): AgentSessionState {
  switch (event.type) {
    case 'permission_required':
      return {
        ...current,
        pendingInteractions: appendPending(current.pendingInteractions, permissionInteraction(event)),
      };
    case 'ask_user_required':
      return {
        ...current,
        pendingInteractions: appendPending(current.pendingInteractions, {
          kind: 'askUser',
          createdAt: Date.now(),
          request: event,
        }),
      };
    case 'permission_resolved':
    case 'ask_user_resolved':
      return {
        ...current,
        pendingInteractions: removePending(current.pendingInteractions, event.toolCallId),
      };
    default:
      return current;
  }
}

export const useAgentStore = create<AgentStore>()((set, get) => {
  const receive = (sessionId: string, message: AgentServerMessage): void => {
    if (message.type === 'session_state') {
      set(state => ({
        sessions: updateSession(state.sessions, sessionId, current => ({
          ...current,
          execution: message.execution,
        })),
      }));
      return;
    }
    if (message.type === 'pending_interactions') {
      set(state => ({
        sessions: updateSession(state.sessions, sessionId, current => ({
          ...current,
          pendingInteractions: message.pending,
        })),
      }));
      return;
    }
    if (message.type !== 'turn_event') return;

    set(state => ({
      sessions: updateSession(state.sessions, sessionId, current => applyTurnEvent(current, message.event)),
    }));
    for (const listener of [...(turnEventListeners.get(sessionId) ?? [])]) {
      listener(message.turnId, message.event);
    }
  };

  const connectSession = (sessionId: string): void => {
    if (connectionSubscriptions.has(sessionId)) return;
    set(state => ({
      sessions: updateSession(state.sessions, sessionId, current => current),
    }));
    const unsubscribe = agentWebSocket.subscribe(sessionId, {
      onMessage: message => receive(sessionId, message),
      onConnectionState: connection => {
        set(state => ({
          sessions: updateSession(state.sessions, sessionId, current => ({ ...current, connection })),
        }));
      },
    });
    connectionSubscriptions.set(sessionId, unsubscribe);
  };

  const removeResolvedInteraction = (sessionId: string, toolCallId: string): void => {
    set(state => ({
      sessions: updateSession(state.sessions, sessionId, current => ({
        ...current,
        pendingInteractions: removePending(current.pendingInteractions, toolCallId),
      })),
    }));
  };

  return {
    sessions: new Map(),
    connectSession,

    disconnectSession(sessionId) {
      connectionSubscriptions.get(sessionId)?.();
      connectionSubscriptions.delete(sessionId);
      agentWebSocket.disconnect(sessionId);
      turnEventListeners.delete(sessionId);
      set(state => {
        const sessions = new Map(state.sessions);
        sessions.delete(sessionId);
        return { sessions };
      });
    },

    startTurn(sessionId, payload) {
      connectSession(sessionId);
      return agentWebSocket.startTurn(sessionId, payload);
    },

    startCompaction(sessionId) {
      connectSession(sessionId);
      return agentWebSocket.startCompaction(sessionId);
    },

    cancelExecution(sessionId) {
      const execution = get().sessions.get(sessionId)?.execution;
      if (!execution) return Promise.reject(new Error('当前 Session 没有运行中的执行'));
      return agentWebSocket.cancelExecution(sessionId, execution.executionId);
    },

    cancelTool(sessionId, turnId, toolCallId) {
      return agentWebSocket.cancelTool(sessionId, turnId, toolCallId);
    },

    async respondPermission(sessionId, turnId, toolCallId, response) {
      await agentWebSocket.respondPermission(sessionId, turnId, toolCallId, response);
      removeResolvedInteraction(sessionId, toolCallId);
    },

    async respondAskUser(sessionId, turnId, toolCallId, answers) {
      await agentWebSocket.respondAskUser(sessionId, turnId, toolCallId, answers);
      removeResolvedInteraction(sessionId, toolCallId);
    },

    async cancelAskUser(sessionId, turnId, toolCallId) {
      await agentWebSocket.cancelAskUser(sessionId, turnId, toolCallId);
      removeResolvedInteraction(sessionId, toolCallId);
    },
  };
});

/** Turn 增量不进入 Zustand 历史；未来的新 Chat Store 在挂载 Session 时从这里消费。 */
export function subscribeSessionTurnEvents(
  sessionId: string,
  listener: TurnEventListener,
): () => void {
  const listeners = turnEventListeners.get(sessionId) ?? new Set<TurnEventListener>();
  listeners.add(listener);
  turnEventListeners.set(sessionId, listeners);
  useAgentStore.getState().connectSession(sessionId);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) turnEventListeners.delete(sessionId);
  };
}
