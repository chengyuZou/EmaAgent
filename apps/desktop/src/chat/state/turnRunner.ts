// 发送管线：POST /turns、Turn SSE 生命周期、停止与会话资源回收。
import { startTurnSseLifecycle } from '../../lib/turn-sse-lifecycle.js';
import { handleTurnAborted, evictSessionPlayers } from '../../lib/tts-playback.js';
import { sessionsApi } from '../../api/sessions.js';
import { turnsApi, type TurnCreateInput, type TurnAttachmentInput } from '../../api/turns.js';
import { useAgentRunStore } from '../../stores/agentRun.js';
import { useSessionAttachmentStore } from '../../stores/sessionAttachment.js';
import { useSessionStore } from '../../stores/session.js';
import { useTaskStore } from '../../stores/task.js';
import { useSessionHistory } from '../history/sessionHistory.js';
import { useDockTabs } from '../frame/dockTabs.js';
import { closeSessionTerminals } from '../frame/tabs/terminal/terminalSessions.js';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { useCurrentSession } from './currentSession.js';
import { useMessages } from './messages.js';
import { dispatchTurnEvent } from './turnEvents.js';
// ── per-session 资源 ──────────────────────────────────────────────────────────

const sseHandles = new Map<string, { stop(): void }>();

// ── 公开入口 ──────────────────────────────────────────────────────────────────

/** Turn 创建成功后 resolve；后续 SSE 连接由本模块持有。 */
export async function sendMessage(
  input: TurnCreateInput,
): Promise<void> {
  let targetId = input.sessionId;
  let createdNewSession = false;

  if (!targetId) {
    const newSession = await sessionsApi.create();
    targetId = newSession.id;
    createdNewSession = true;
    void useSessionStore.getState().loadSessions();
    useCurrentSession.setState({ viewedSessionId: targetId });
  }
  useSessionHistory.getState().showTail(targetId);

  // 乐观输入只活到后端持久消息经重拉就位为止（见 beginStream 的重拉）。
  useMessages.getState().setPendingInput(targetId, {
    parts: input.input,
    createdAt: Date.now(),
  });

  const { turnId, sessionId: acceptedSessionId } = await turnsApi.create({
    ...input,
    sessionId: targetId,
  });

  if (acceptedSessionId !== targetId) {
    void useSessionStore.getState().loadSessions();
    useCurrentSession.setState({ viewedSessionId: acceptedSessionId });
  }

  const lifecycle = startTurnSseLifecycle({
    openResponse: (signal, lastEventId) => turnsApi.openEvents(turnId, lastEventId, signal),
    onEvent(event) {
      const sid = ('sessionId' in event && event.sessionId)
        ? event.sessionId
        : acceptedSessionId;
      dispatchTurnEvent(event, sid);
    },
    onPermanentDisconnect(error) {
      console.error('[turn-runner] SSE failed permanently', error);
      useMessages.getState().abortStream(acceptedSessionId, `连接中断：${error.message}`);
    },
  });
  sseHandles.set(acceptedSessionId, lifecycle);
  void lifecycle.done.then(() => {
    if (sseHandles.get(acceptedSessionId) === lifecycle) {
      sseHandles.delete(acceptedSessionId);
    }
  });

  // 附件在 POST /turns 返回前已经持久化；面板若已加载，立即刷新当前 Session，
  // 未打开过的会话不额外发请求，首次打开时再按需加载。
  if (input.input.some((part) => part.type === 'attachment')
    && useSessionAttachmentStore.getState().bySession.has(acceptedSessionId)) {
    void useSessionAttachmentStore.getState()
      .loadForSession(acceptedSessionId, true)
      .catch(() => {});
  }

  if (createdNewSession) {
    useMessages.setState((s) => {
      const loadedSessions = new Set(s.loadedSessions);
      loadedSessions.add(acceptedSessionId);
      return { loadedSessions };
    });
  }
  useSessionHistory.getState().invalidateTurnIndex(acceptedSessionId);
}

/** 停止是 Session 级操作：只断开 SSE 不会停止后端执行；界面收口与中止信号并行。 */
export function stopStreaming(sessionId: string): void {
  void sessionsApi.abort(sessionId).catch(() => {});
  sseHandles.get(sessionId)?.stop();
  sseHandles.delete(sessionId);
  handleTurnAborted(sessionId);
  useMessages.getState().abortStream(sessionId, '已停止');
}

/** 会话删除时的聊天域资源回收编排。 */
export function evictChatSession(sessionId: string): void {
  void closeSessionTerminals(sessionId).catch(() => {});
  const layout = useDockTabs.getState().layouts[sessionId];
  if (layout) {
    for (const tab of Object.values(layout.tabsById)) {
      if (tab.kind === 'browser') void tauriBridge.closeBrowser(tab.browserId).catch(() => {});
    }
  }
  sseHandles.get(sessionId)?.stop();
  sseHandles.delete(sessionId);
  evictSessionPlayers(sessionId);
  useAgentRunStore.getState().evictSession(sessionId);
  useSessionAttachmentStore.getState().evictSession(sessionId);
  useSessionHistory.getState().evictSession(sessionId);
  useTaskStore.getState().evictSession(sessionId);
  useMessages.getState().evictSession(sessionId);
  useCurrentSession.getState().evictSession(sessionId);
  useDockTabs.getState().removeSessionLayout(sessionId);
}
