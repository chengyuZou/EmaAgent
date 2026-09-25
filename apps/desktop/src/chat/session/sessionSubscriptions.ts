import type { SubagentEvent } from '@ema-agent/agent';
import type { SessionMessage } from '@ema-agent/session';
import type { SessionBusinessMessage } from '@ema-agent/server/routes/ws/session.js';
import { sessionWebSocket } from '../../api/sessionWebSocket.js';
import {
  resolveConfiguredEventNotification,
  type NotifiableEvent,
} from '../../lib/event-notifications.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';
import { useSubagentStore } from '../../stores/subagent.js';
import {
  useTurnStore,
  type TurnStoreEvent,
} from '../../stores/turn.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useSessionHistoryStore } from '../../stores/sessionHistory.js';
import { useSettingsStore } from '../../stores/settings.js';
import { sessionPresentation } from '../presentation/sessionPresentation.js';
import {
  cancelTurnSpeech,
  startTurnSpeechPlayback,
} from '../speech/turnSpeechPlayback.js';
import { scheduleTurnHistoryClosure } from './turnHistoryClosure.js';

const subscriptions = new Map<string, () => void>();

type SessionCompactEvent = Extract<SessionBusinessMessage, {
  readonly type:
    | 'compact_started'
    | 'compact_cancelled'
    | 'compact_completed'
    | 'compact_failed';
}>;

export function ensureSessionSubscription(sessionId: string): void {
  if (subscriptions.has(sessionId)) return;
  subscriptions.set(sessionId, sessionWebSocket.subscribe(sessionId, {
    onMessage: message => receiveSessionMessage(sessionId, message),
    onConnectionState: connection => {
      useSessionActivityStore.getState().setConnection(sessionId, connection);
    },
  }));
}

export function syncSessionSubscriptions(sessionIds: ReadonlySet<string>): void {
  const desired = sessionIds;
  for (const sessionId of desired) ensureSessionSubscription(sessionId);
  for (const sessionId of [...subscriptions.keys()]) {
    if (!desired.has(sessionId)) removeSessionSubscription(sessionId);
  }
}

/** 只停止这个 Session 的网络观察;删除或归档后的业务状态由 removeSessionFromChat 清理. */
export function removeSessionSubscription(sessionId: string): void {
  subscriptions.get(sessionId)?.();
  subscriptions.delete(sessionId);
  useSessionActivityStore.getState().setConnection(sessionId, 'disconnected');
  sessionWebSocket.disconnect(sessionId);
}

export function clearSessionSubscriptions(): void {
  for (const sessionId of [...subscriptions.keys()]) removeSessionSubscription(sessionId);
}

function receiveSessionMessage(sessionId: string, message: SessionBusinessMessage): void {
  const activity = useSessionActivityStore.getState();
  if (message.type === 'session_state') {
    activity.replaceSessionState(
      sessionId,
      message.running,
      message.pendingInteractions,
      message.queuedInputs,
    );
    if (message.running?.kind === 'turn') {
      useTurnStore.getState().restore(
        sessionId,
        message.running.turnId,
        message.running.createdAt,
        message.running.sessionMode,
        message.running.narrativePolicy,
        message.running.messages,
      );
    }
    return;
  }
  if (message.type === 'session_running_changed') {
    activity.setRunning(sessionId, message.running);
    return;
  }
  if (message.type === 'queued_input_added') {
    activity.addQueuedInput(sessionId, message.item);
    return;
  }
  if (message.type === 'queued_input_removed') {
    activity.removeQueuedInput(sessionId, message.id);
    return;
  }
  if (message.type === 'queued_input_guided') {
    activity.removeQueuedInput(sessionId, message.item.id);
    return;
  }
  if (message.type === 'user_message_stored') {
    receiveStoredUserMessage(sessionId, message.message);
    return;
  }
  if (isCompactEvent(message)) {
    receiveCompactEvent(sessionId, message);
    return;
  }
  if (message.type === 'subagent_event') {
    receiveSubagentEvent(sessionId, message.event);
    return;
  }
  if (message.type === 'turn_event') {
    receiveTurnEvent(
      sessionId,
      message.turnId,
      message.event,
      'ttsEnabled' in message ? message.ttsEnabled : undefined,
    );
  }
}

function receiveStoredUserMessage(sessionId: string, message: SessionMessage): void {
  if (!useTurnStore.getState().receiveUserMessage(sessionId, message)) {
    useSessionHistoryStore.getState().appendMessage(sessionId, message);
  }
}

function isCompactEvent(message: SessionBusinessMessage): message is SessionCompactEvent {
  return message.type === 'compact_started'
    || message.type === 'compact_cancelled'
    || message.type === 'compact_completed'
    || message.type === 'compact_failed';
}

function receiveCompactEvent(sessionId: string, event: SessionCompactEvent): void {
  presentSessionEvent(event);
  if (event.type === 'compact_completed') {
    useTurnStore.getState().invalidateContextUsage(sessionId);
    void useSessionHistoryStore.getState().loadLatest(sessionId, true);
  }
}

function receiveTurnEvent(
  sessionId: string,
  turnId: string,
  event: TurnStoreEvent,
  ttsEnabled?: boolean,
): void {
  presentSessionEvent(event);
  useSessionActivityStore.getState().applyInteractionEvent(sessionId, event);
  useTurnStore.getState().receiveTurnEvent(sessionId, turnId, event);

  switch (event.type) {
    case 'turn_started':
      if (ttsEnabled) {
        startTurnSpeechPlayback(sessionId, turnId);
      } else {
        sessionPresentation.claim(sessionId, turnId, false, () => {});
      }
      return;
    case 'output_text_delta':
      sessionPresentation.text(sessionId, turnId, event.delta);
      return;
    case 'emotion_changed':
      sessionPresentation.emotion(sessionId, turnId, event.emotion);
      return;
    case 'motion_changed':
      sessionPresentation.motion(sessionId, turnId, event.motion);
      return;
    case 'permission_required':
    case 'ask_user_required':
      void tauriBridge.publishDecisionRequired(event);
      return;
    case 'permission_resolved':
    case 'ask_user_resolved':
      void tauriBridge.publishDecisionDismissed(event.toolCallId);
      return;
    case 'turn_completed':
      sessionPresentation.finishTurn(sessionId, turnId);
      scheduleTurnHistoryClosure(sessionId);
      return;
    case 'turn_failed':
    case 'turn_aborted':
      // 失败或用户取消以后不再播放剩余句子. Speech 先结算, Presentation 再按
      // turnTerminal && speechSettled 判断是否把桌宠交给 FIFO 队首.
      cancelTurnSpeech(turnId);
      sessionPresentation.finishTurn(sessionId, turnId);
      scheduleTurnHistoryClosure(sessionId);
      return;
    case 'compact_completed':
      useTurnStore.getState().invalidateContextUsage(sessionId);
      return;
    case 'request_degraded':
      console.info('[session] request_degraded:', event);
      return;
    case 'turn_projection_warning':
      console.warn('[session] turn_projection_warning:', event);
      return;
    case 'agent_iteration':
    case 'agent_usage_updated':
    case 'reasoning_delta':
    case 'reasoning_complete':
    case 'tool_call_partial':
    case 'tool_call_complete':
    case 'tool_progress':
    case 'tool_result':
    case 'context_usage_updated':
    case 'compact_started':
    case 'compact_cancelled':
    case 'compact_failed':
    case 'narrative_recall_started':
    case 'narrative_recall_completed':
    case 'narrative_recall_failed':
      return;
    default:
      event satisfies never;
  }
}

function presentSessionEvent(event: NotifiableEvent): void {
  const config = useSettingsStore.getState().eventDisplay?.[event.type];
  const notification = resolveConfiguredEventNotification(event, config);
  if (!notification) return;
  showToast(notification.message, {
    variant: notification.variant,
    duration: notification.duration,
    accentColor: notification.accentColor,
  });
}

function receiveSubagentEvent(sessionId: string, event: SubagentEvent): void {
  const subagents = useSubagentStore.getState();
  if (event.type === 'subagent_started') {
    subagents.startProgress({
      id: event.subagentId,
      sessionId,
      startedAtMs: event.startedAt,
      ...(event.description !== undefined ? { description: event.description } : {}),
      ...(event.modelId !== undefined ? { modelId: event.modelId } : {}),
      iteration: 0,
      toolCallCount: 0,
    });
    return;
  }
  if (
    event.type === 'subagent_completed'
    || event.type === 'subagent_failed'
    || event.type === 'subagent_aborted'
  ) {
    subagents.finishProgress(event.subagentId);
    return;
  }
  subagents.receiveMessageEvent(event);
}
