// 解释每个 Session 的 Agent WebSocket 消息, 并把实时状态投影给 Chat 各视图.
import { create } from 'zustand';
import type { PermissionResponse } from '@ema-agent/permission';
import type { ActiveSessionExecution } from '@ema-agent/session';
import type { PendingInteraction, QueuedSessionInput, TurnStreamEvent } from '@ema-agent/turn';
import type { AgentRunEvent } from '@ema-agent/agent';
import type { AgentServerMessage, EnqueueInputPayload } from '@ema-agent/server/routes/ws/agent.js';
import { agentWebSocket, type AgentConnectionState } from '../api/websocket.js';
import { presentConfiguredEvent } from '../lib/event-notifications.js';
import { tauriBridge } from '../lib/tauri-bridge.js';
import { handleTurnAborted } from '../lib/tts-playback.js';
import { useAgentRunStore } from './agentRun.js';
import { useTaskStore } from './task.js';
import { useHistoryStore } from '../chat/state/history.js';
import { useLiveTurns } from '../chat/state/liveTurns.js';

export interface AgentSessionState {
  readonly connection: AgentConnectionState;
  readonly execution: ActiveSessionExecution | null;
  readonly pendingInteractions: readonly PendingInteraction[];
  readonly queuedInputs: readonly QueuedSessionInput[];
}

type CommandCompactResult = Extract<AgentServerMessage, { type: 'compaction_completed' }>['result'];

interface AgentStore {
  readonly sessions: ReadonlyMap<string, AgentSessionState>;
  connectSession(sessionId: string): void;
  disconnectSession(sessionId: string): void;
  enqueueInput(sessionId: string, payload: EnqueueInputPayload): Promise<void>;
  removeQueuedInput(sessionId: string, id: string): Promise<void>;
  guideQueuedInput(sessionId: string, id: string): Promise<void>;
  startCompaction(sessionId: string): Promise<CommandCompactResult>;
  cancelExecution(sessionId: string): Promise<void>;
  cancelTool(sessionId: string, turnId: string, toolCallId: string): Promise<void>;
  cancelAgentRun(sessionId: string, agentRunId: string): Promise<void>;
  respondPermission(sessionId: string, turnId: string, toolCallId: string, response: PermissionResponse): Promise<void>;
  respondAskUser(sessionId: string, turnId: string, toolCallId: string, answers: Record<string, string>): Promise<void>;
  cancelAskUser(sessionId: string, turnId: string, toolCallId: string): Promise<void>;
}

const subscriptions = new Map<string, () => void>();

function emptySession(): AgentSessionState {
  return {
    connection: 'disconnected',
    execution: null,
    pendingInteractions: [],
    queuedInputs: [],
  };
}

function updateSession(
  sessions: ReadonlyMap<string, AgentSessionState>,
  sessionId: string,
  update: (current: AgentSessionState) => AgentSessionState,
): ReadonlyMap<string, AgentSessionState> {
  const next = new Map(sessions);
  next.set(sessionId, update(sessions.get(sessionId) ?? emptySession()));
  return next;
}

function sortPending(items: readonly PendingInteraction[]): PendingInteraction[] {
  return [...items].sort((left, right) => left.createdAt - right.createdAt);
}

function removePending(items: readonly PendingInteraction[], toolCallId: string): PendingInteraction[] {
  return items.filter(item => item.request.toolCallId !== toolCallId);
}

function permissionInteraction(
  event: Extract<TurnStreamEvent, { type: 'permission_required' }>,
): PendingInteraction {
  const { type: _type, ...request } = event;
  return {
    kind: 'permission',
    toolCallId: event.toolCallId,
    createdAt: Date.now(),
    request,
  };
}

function applyInteractionEvent(current: AgentSessionState, event: TurnStreamEvent): AgentSessionState {
  if (event.type === 'permission_required') {
    return {
      ...current,
      pendingInteractions: sortPending([
        ...removePending(current.pendingInteractions, event.toolCallId),
        permissionInteraction(event),
      ]),
    };
  }
  if (event.type === 'ask_user_required') {
    return {
      ...current,
      pendingInteractions: sortPending([
        ...removePending(current.pendingInteractions, event.toolCallId),
        { kind: 'askUser', createdAt: Date.now(), request: event },
      ]),
    };
  }
  if (event.type === 'permission_resolved' || event.type === 'ask_user_resolved') {
    return {
      ...current,
      pendingInteractions: removePending(current.pendingInteractions, event.toolCallId),
    };
  }
  return current;
}

function dispatchTurnEvent(sessionId: string, turnId: string, event: TurnStreamEvent): void {
  presentConfiguredEvent(event);
  const live = useLiveTurns.getState();
  switch (event.type) {
    case 'turn_started':
      live.begin(sessionId, turnId, event.executionProfile, event.narrativePolicy);
      live.claimStageOwner(sessionId);
      void tauriBridge.publishSpeechStarted(sessionId);
      return;
    case 'turn_completed':
      live.clearTurnUsage(turnId);
      live.settle(sessionId, turnId);
      void useTaskStore.getState().loadForSession(sessionId, true);
      void tauriBridge.publishSpeechEnded(sessionId);
      return;
    case 'turn_failed':
    case 'turn_aborted': {
      handleTurnAborted(sessionId);
      live.clearTurnUsage(turnId);
      live.abort(sessionId, turnId, event.type === 'turn_failed' ? event.message : event.reason);
      void useTaskStore.getState().loadForSession(sessionId, true);
      void tauriBridge.publishSpeechEnded(sessionId);
      return;
    }
    case 'context_usage_updated':
      live.applyContextUsage(sessionId, event.llmCallId, event.usage);
      return;
    case 'agent_usage_updated':
      live.setRootUsage(turnId, event.usage);
      return;
    case 'output_text_delta':
      live.appendText(sessionId, event.blockIndex, event.delta);
      void tauriBridge.publishSpeechDelta(sessionId, event.delta);
      return;
    case 'reasoning_delta':
      live.appendThinking(sessionId, event.blockIndex, event.delta);
      return;
    case 'reasoning_complete':
      live.finishThinking(sessionId, event.blockIndex);
      return;
    case 'tool_call_partial':
      live.upsertPartialTool(sessionId, event.blockIndex, event.callId, event.name, event.argsDelta);
      return;
    case 'tool_call_complete':
      live.completeTool(sessionId, event.blockIndex, event.callId, event.name, event.args);
      return;
    case 'tool_progress':
      live.appendToolProgress(sessionId, event.callId, event.progress);
      return;
    case 'tool_result':
      live.setToolResult(sessionId, event.callId, {
        ...(event.output !== undefined ? { output: event.output } : {}),
        ...(event.error ? { error: event.error } : {}),
        durationMs: event.durationMs,
      });
      return;
    case 'permission_required':
      live.setToolPermissionPending(sessionId, event.toolCallId, true);
      void tauriBridge.publishDecisionRequired(event);
      return;
    case 'permission_resolved':
      live.setToolPermissionPending(sessionId, event.toolCallId, false);
      void tauriBridge.publishDecisionDismissed(event.toolCallId);
      return;
    case 'ask_user_required':
      void tauriBridge.publishDecisionRequired(event);
      return;
    case 'ask_user_resolved':
      void tauriBridge.publishDecisionDismissed(event.toolCallId);
      return;
    case 'emotion_changed':
      live.setEmotion(sessionId, event.emotion);
      return;
    case 'motion_changed':
      if (live.stageOwnerSessionId === sessionId) void tauriBridge.publishStageMotion(event.motion);
      return;
    case 'agent_iteration':
      live.setIteration(sessionId, event.n);
      return;
    case 'narrative_recall_started':
      live.narrativeStarted(sessionId);
      return;
    case 'narrative_recall_completed':
      live.narrativeCompleted(sessionId, event);
      return;
    case 'narrative_recall_failed':
      live.narrativeFailed(sessionId, event.message);
      return;
    case 'compact_completed':
      void useHistoryStore.getState().loadLatest(sessionId, true);
      return;
    case 'request_degraded':
      console.info('[agent-channel] request_degraded:', event);
      return;
    case 'turn_projection_warning':
      console.warn('[agent-channel] turn_projection_warning:', event);
      return;
    case 'compact_started':
    case 'compact_history_truncated':
    case 'compact_cancelled':
    case 'compact_failed':
      return;
    default:
      event satisfies never;
  }
}

function dispatchAgentRunEvent(sessionId: string, event: AgentRunEvent): void {
  const runs = useAgentRunStore.getState();
  if (event.type === 'agent_run_started') {
    runs.startLive({
      id: event.agentRunId,
      sessionId,
      startedAtMs: event.startedAt,
      ...(event.description !== undefined ? { description: event.description } : {}),
      ...(event.modelId !== undefined ? { modelId: event.modelId } : {}),
      iteration: 0,
      toolCallCount: 0,
    });
    return;
  }
  if (event.type === 'agent_run_completed' || event.type === 'agent_run_failed' || event.type === 'agent_run_aborted') {
    runs.finishLive(event.agentRunId);
    return;
  }
  const inner = event.event;
  if (inner.type === 'iteration_started') {
    runs.patchLive(event.agentRunId, { iteration: inner.iteration });
  } else if (inner.type === 'text_delta') {
    runs.appendLiveTranscript(event.agentRunId, {
      role: 'assistant',
      blockIndex: inner.blockIndex,
      text: inner.delta,
    });
  } else if (inner.type === 'thinking_delta') {
    runs.appendLiveTranscript(event.agentRunId, {
      role: 'reasoning',
      blockIndex: inner.blockIndex,
      text: inner.delta,
    });
  } else if (inner.type === 'tool_use_completed') {
    runs.appendLiveTranscript(event.agentRunId, {
      role: 'tool_call',
      blockIndex: inner.blockIndex,
      callId: inner.toolCallId,
      name: inner.toolName,
      args: inner.args,
    });
    runs.patchLive(event.agentRunId, { toolCallCount: (runs.live.get(event.agentRunId)?.toolCallCount ?? 0) + 1 });
  } else if (inner.type === 'tool_result') {
    runs.appendLiveTranscript(event.agentRunId, { role: 'tool_result', result: inner.result });
  }
}

export const useAgentStore = create<AgentStore>((set, get) => {
  const receive = (sessionId: string, message: AgentServerMessage): void => {
    if (message.type === 'session_state') {
      set(state => ({
        sessions: updateSession(state.sessions, sessionId, current => ({ ...current, execution: message.execution })),
      }));
      return;
    }
    if (message.type === 'pending_interactions') {
      set(state => ({
        sessions: updateSession(state.sessions, sessionId, current => ({
          ...current,
          pendingInteractions: sortPending(message.pending),
        })),
      }));
      return;
    }
    if (message.type === 'queued_inputs') {
      set(state => ({
        sessions: updateSession(state.sessions, sessionId, current => ({ ...current, queuedInputs: message.items })),
      }));
      return;
    }
    if (message.type === 'queued_input_added' || message.type === 'queued_input_updated') {
      set(state => ({
        sessions: updateSession(state.sessions, sessionId, current => ({
          ...current,
          queuedInputs: [
            ...current.queuedInputs.filter(item => item.id !== message.item.id),
            message.item,
          ].sort((a, b) => a.createdAt - b.createdAt),
        })),
      }));
      return;
    }
    if (message.type === 'queued_input_removed') {
      set(state => ({
        sessions: updateSession(state.sessions, sessionId, current => ({
          ...current,
          queuedInputs: current.queuedInputs.filter(item => item.id !== message.id),
        })),
      }));
      return;
    }
    if (message.type === 'queued_inputs_consumed') {
      const ids = new Set(message.ids);
      set(state => ({
        sessions: updateSession(state.sessions, sessionId, current => ({
          ...current,
          queuedInputs: current.queuedInputs.filter(item => !ids.has(item.id)),
        })),
      }));
      return;
    }
    if (message.type === 'turn_event') {
      set(state => ({
        sessions: updateSession(state.sessions, sessionId, current => {
          const withInteraction = applyInteractionEvent(current, message.event);
          if (message.event.type === 'turn_started') {
            return { ...withInteraction, execution: { executionId: message.turnId, kind: 'turn' } };
          }
          if (message.event.type === 'turn_completed' || message.event.type === 'turn_failed' || message.event.type === 'turn_aborted') {
            return { ...withInteraction, execution: null };
          }
          return withInteraction;
        }),
      }));
      dispatchTurnEvent(sessionId, message.turnId, message.event);
      return;
    }
    if (message.type === 'agent_run_event') dispatchAgentRunEvent(sessionId, message.event);
  };

  const connectSession = (sessionId: string): void => {
    if (subscriptions.has(sessionId)) return;
    set(state => ({ sessions: updateSession(state.sessions, sessionId, current => current) }));
    subscriptions.set(sessionId, agentWebSocket.subscribe(sessionId, {
      onMessage: message => receive(sessionId, message),
      onConnectionState: connection => set(state => ({
        sessions: updateSession(state.sessions, sessionId, current => ({ ...current, connection })),
      })),
    }));
  };

  return {
    sessions: new Map(),

    connectSession,

    disconnectSession(sessionId) {
      subscriptions.get(sessionId)?.();
      subscriptions.delete(sessionId);
      agentWebSocket.disconnect(sessionId);
      set(state => {
        const sessions = new Map(state.sessions);
        sessions.delete(sessionId);
        return { sessions };
      });
    },

    enqueueInput(sessionId, payload) {
      connectSession(sessionId);
      return agentWebSocket.enqueueInput(sessionId, payload);
    },

    removeQueuedInput(sessionId, id) {
      return agentWebSocket.removeQueuedInput(sessionId, id);
    },

    guideQueuedInput(sessionId, id) {
      return agentWebSocket.guideQueuedInput(sessionId, id);
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

    cancelAgentRun(sessionId, agentRunId) {
      return agentWebSocket.cancelAgentRun(sessionId, agentRunId);
    },

    respondPermission(sessionId, turnId, toolCallId, response) {
      return agentWebSocket.respondPermission(sessionId, turnId, toolCallId, response);
    },

    respondAskUser(sessionId, turnId, toolCallId, answers) {
      return agentWebSocket.respondAskUser(sessionId, turnId, toolCallId, answers);
    },

    cancelAskUser(sessionId, turnId, toolCallId) {
      return agentWebSocket.cancelAskUser(sessionId, turnId, toolCallId);
    },
  };
});
