import { SessionRequestError, sessionWebSocket } from '../../api/sessionWebSocket.js';
import { MainView, useMainNavigationStore } from '../../layout/navigation.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useSessionStore } from '../../stores/session.js';
import { tauriBridge } from '../tauri/tauriBridge.js';
import type {
  DesktopNotificationAction,
  InteractionNotificationUpdate,
} from '../tauri/types.js';
import { subscribeSystemEvent } from '../events/systemEventDispatcher.js';
import { notifySessionCompletion } from './sessionCompletionNotifications.js';
import { showToast } from './toast.js';

function readNotifications(): InteractionNotificationUpdate {
  const navigation = useMainNavigationStore.getState();
  const sessions = useSessionStore.getState().sessions.byId;
  const notifications: InteractionNotificationUpdate['notifications'][number][] = [];
  for (const [sessionId, activity] of useSessionActivityStore.getState().bySession) {
    const pending = activity.pendingInteractions[0];
    if (!pending) continue;
    const title = sessions.get(sessionId)?.title || '新对话';
    let body = '你的助手有个问题想问你';
    if (pending.kind === 'permission') {
      const request = pending.request;
      body = `工具 ${request.toolName} 正在等待你的授权`;
      body += `\n${request.message}`;
      if (request.sessionApprovalDescription) body += `\n${request.sessionApprovalDescription}`;
    }
    notifications.push({
      sessionId,
      turnId: pending.request.turnId,
      toolCallId: pending.request.toolCallId,
      kind: pending.kind,
      ...(pending.kind === 'permission' && pending.request.sessionApprovalDescription !== undefined
        ? { sessionApprovalDescription: pending.request.sessionApprovalDescription }
        : {}),
      title,
      body,
    });
  }
  return {
    viewedSessionId: navigation.activeView === MainView.Chat ? navigation.viewedSessionId : null,
    notifications,
  };
}

async function openSession(sessionId: string): Promise<void> {
  if (!useSessionStore.getState().sessions.byId.has(sessionId)) {
    await useSessionStore.getState().loadSessions();
  }
  if (!useSessionStore.getState().sessions.byId.has(sessionId)) {
    return;
  }
  useMainNavigationStore.getState().viewSession(sessionId);
  await tauriBridge.openMainWindow();
}

/** Mounted once by main, not by a Session view or the character stage. */
export function mountDesktopNotifications(): () => void {
  let disposed = false;
  let syncing = false;
  let syncRequested = false;
  let lastError: string | null = null;
  const stops: Array<() => void> = [];
  const submitting = new Set<string>();

  function reportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (lastError === message) return;
    lastError = message;
    console.warn('[interaction-notifications]', error);
    showToast(`系统交互通知不可用, 请在聊天中处理: ${message}`, { variant: 'warning' });
  }

  async function flush(): Promise<void> {
    if (syncing || disposed) return;
    syncing = true;
    try {
      while (syncRequested && !disposed) {
        syncRequested = false;
        // Read current facts after the previous IPC finishes. A late update must
        // not recreate a notification already removed by a resolved event.
        const update = readNotifications();
        try {
          await tauriBridge.syncInteractionNotifications(update);
          lastError = null;
        } catch (error) {
          if (!disposed) reportFailure(error);
        }
      }
    } finally {
      syncing = false;
    }
  }

  function sync(): void {
    syncRequested = true;
    void flush();
  }

  async function respond(action: DesktopNotificationAction): Promise<void> {
    if (disposed) return;
    if (action.action === 'openSession') {
      await openSession(action.sessionId);
      return;
    }
    // Providers can reuse a call ID in another Session or a later Turn.
    const requestKey = JSON.stringify([action.sessionId, action.turnId, action.toolCallId]);
    if (submitting.has(requestKey)) return;
    const activity = useSessionActivityStore.getState().bySession.get(action.sessionId);
    const pending = activity?.pendingInteractions[0];
    if (pending?.kind !== 'permission'
      || pending.request.turnId !== action.turnId
      || pending.request.toolCallId !== action.toolCallId) {
      sync();
      return;
    }
    if (activity?.connection !== 'connected') {
      await openSession(action.sessionId);
      showToast('Session 连接尚未恢复, 请在聊天中确认后重试', { variant: 'warning' });
      return;
    }
    submitting.add(requestKey);
    try {
      // Reuse the same business entry as the chat buttons. Store removal still
      // waits for Server's resolved event, including cancellation and timeout.
      await sessionWebSocket.respondPermission(action.sessionId, action.toolCallId, {
        action: action.action,
      });
    } catch (error) {
      if (error instanceof SessionRequestError && error.code === 'not_found_or_expired') {
        return;
      }
      await openSession(action.sessionId);
      showToast(`权限答复提交失败, 请在聊天中确认: ${error instanceof Error ? error.message : String(error)}`, {
        variant: 'danger',
      });
    } finally {
      submitting.delete(requestKey);
    }
  }

  // Install the action channel before publishing any notification. Hidden main
  // keeps this listener and the Session sockets alive.
  void tauriBridge.connectDesktopNotifications(action => {
    void respond(action).catch(error => {
      if (!disposed) reportFailure(error);
    });
  }).then(supported => {
    if (disposed || !supported) return;
    stops.push(
      subscribeSystemEvent(event => {
        if (event.type === 'turn_completed' || event.type === 'turn_failed') {
          void notifySessionCompletion(
            event.sessionId, event.turnId,
            event.type === 'turn_completed' ? 'turnCompleted' : 'turnFailed',
          );
        }
      }),
      useSessionActivityStore.subscribe(sync),
      useSessionStore.subscribe(sync),
      useMainNavigationStore.subscribe(sync),
    );
    sync();
  }).catch(error => {
    if (!disposed) reportFailure(error);
  });

  return () => {
    disposed = true;
    for (const stop of stops) stop();
  };
}
