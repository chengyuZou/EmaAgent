import type { SubagentEvent } from '@ema-agent/agent';
import type { SessionMessage } from '@ema-agent/session';
import type { SessionBusinessMessage } from '@ema-agent/server/routes/ws/session.js';
import { sessionWebSocket } from '../../api/sessionWebSocket.js';
import { resolveConfiguredEventNotification, type NotifiableEvent } from '../../lib/event-notifications.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { showToast } from '../../lib/toast.js';
import { useSubagentStore } from '../../stores/subagent.js';
import { useTurnStore, type TurnStoreEvent } from '../../stores/turn.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useSessionHistoryStore } from '../../stores/sessionHistory.js';
import { useSettingsStore } from '../../stores/settings.js';
import { sessionPresentation } from '../presentation/sessionPresentation.js';
import { startTurnSpeechPlayback, stopTurnPlayback } from '../speech/turnSpeechPlayback.js';
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
  if (subscriptions.has(sessionId)) {
    return;
  }
  subscriptions.set(
    sessionId,
    sessionWebSocket.subscribe(
      sessionId,
      {
        onMessage: message => receiveSessionMessage(sessionId, message),
        onConnectionState: connection => {
          useSessionActivityStore.getState().setConnection(sessionId, connection);
        },
      }
    )
  );
}

export function syncSessionSubscriptions(sessionIds: ReadonlySet<string>): void {
  const desired = sessionIds;
  for (const sessionId of desired) {
    ensureSessionSubscription(sessionId);
  }
  for (const sessionId of [...subscriptions.keys()]) {
    if (!desired.has(sessionId)) {
      removeSessionSubscription(sessionId);
    }
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
  for (const sessionId of [...subscriptions.keys()]) {
    removeSessionSubscription(sessionId);
  }
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
        message.running.messages,
      );
    }
    for (const pending of message.pendingInteractions) {
      if (pending.kind === 'permission') {
        void tauriBridge.publishDecisionRequired({ type: 'permission_required', ...pending.request });
        if (!pending.request.subagentId) {
          useTurnStore.getState().setToolPermissionPending(
            sessionId,
            pending.request.turnId,
            pending.request.toolCallId,
            true
          );
        }
      } else {
        void tauriBridge.publishDecisionRequired(pending.request);
      }
    }
    return;
  }
  if (message.type === 'session_running_changed') {
    activity.setRunning(sessionId, message.running);
    return;
  }
  if (message.type === 'permission_required' || message.type === 'permission_resolved'
    || message.type === 'ask_user_required'
    || message.type === 'ask_user_resolved') {
    presentSessionEvent(message);
    activity.applyInteractionEvent(sessionId, message);
    if (message.type === 'permission_required' || message.type === 'permission_resolved') {
      if (!message.subagentId) {
        useTurnStore.getState().setToolPermissionPending(
          sessionId,
          message.turnId,
          message.toolCallId,
          message.type === 'permission_required'
        );
      }
    }
    if (message.type === 'permission_required' || message.type === 'ask_user_required') {
      void tauriBridge.publishDecisionRequired(message);
    } else {
      void tauriBridge.publishDecisionDismissed(message.toolCallId);
    }
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
    receiveTurnEvent(sessionId, message.turnId, message.event);
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
  updateCompactActivity(sessionId, event);
  if (event.type === 'compact_completed') {
    useTurnStore.getState().invalidateContextUsage(sessionId);
    void useSessionHistoryStore.getState().loadLatest(sessionId, true);
  }
}

function receiveTurnEvent(sessionId: string, turnId: string, event: TurnStoreEvent): void {
  presentSessionEvent(event);
  useTurnStore.getState().receiveTurnEvent(sessionId, turnId, event);
  if (event.type === 'tool_call_complete') {
    const pending = useSessionActivityStore.getState().bySession.get(sessionId)?.pendingInteractions
      .some(item => item.kind === 'permission' && !item.request.subagentId
        && item.request.turnId === turnId
        && item.request.toolCallId === event.callId);
    if (pending) {
      useTurnStore.getState().setToolPermissionPending(
        sessionId,
        turnId,
        event.callId,
        true
      );
    }
  }

  switch (event.type) {
    case 'turn_started':
      if (event.ttsEnabled) {
        startTurnSpeechPlayback(sessionId, turnId);
      } else {
        sessionPresentation.claim(sessionId, turnId);
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
    case 'turn_completed':
      sessionPresentation.finishTurn(sessionId, turnId);
      scheduleTurnHistoryClosure(sessionId);
      return;
    case 'turn_failed':
    case 'turn_aborted':
      // 失败或用户取消后停止本轮语音, 立即释放 owner; 不补播已经开始的其他 Turn.
      stopTurnPlayback(sessionId, turnId);
      sessionPresentation.finishTurn(sessionId, turnId);
      scheduleTurnHistoryClosure(sessionId);
      return;
    case 'compact_completed':
      updateCompactActivity(sessionId, event);
      useTurnStore.getState().invalidateContextUsage(sessionId);
      return;
    case 'compact_started':
    case 'compact_cancelled':
    case 'compact_failed':
      updateCompactActivity(sessionId, event);
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
      return;
    default:
      event satisfies never;
  }
}

function updateCompactActivity(sessionId: string, event: SessionCompactEvent): void {
  const activity = useSessionActivityStore.getState();
  if (event.type === 'compact_started') {
    activity.startCompact(sessionId, event.compactId, event.startedAt);
  } else {
    activity.finishCompact(sessionId, event.compactId);
  }
}

function presentSessionEvent(event: NotifiableEvent): void {
  const config = useSettingsStore.getState().eventDisplay?.[event.type];
  const notification = resolveConfiguredEventNotification(event, config);
  if (!notification) {
    return;
  }
  showToast(
    notification.message,
    {
      variant: notification.variant,
      duration: notification.duration,
      accentColor: notification.accentColor,
    }
  );
}

function receiveSubagentEvent(sessionId: string, event: SubagentEvent): void {
  useSubagentStore.getState().receiveEvent(sessionId, event);
}
