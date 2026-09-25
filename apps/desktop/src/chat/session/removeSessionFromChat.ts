import { useSubagentStore } from '../../stores/subagent.js';
import { useBackgroundProcessStore } from '../../stores/backgroundProcess.js';
import { useChatDraftStore } from '../../stores/chatDraft.js';
import { useChatNavigationStore } from '../../stores/chatNavigation.js';
import { useSessionHistoryStore } from '../../stores/sessionHistory.js';
import { useTurnStore } from '../../stores/turn.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useSessionPanelStore } from '../../stores/sessionPanel.js';
import { useTaskStore } from '../../stores/task.js';
import { sessionPresentation } from '../presentation/sessionPresentation.js';
import { removeSessionSubscription } from './sessionSubscriptions.js';

/**
 * Session 已经在 Server 归档或删除后, Chat 窗口才会调用这个入口.
 * 这些内存数据分属不同 Store, 但必须在同一个用户操作成功后一起
 * 移除, 否则再次打开同 ID 会看到旧 Draft、Panel 或已断开的运行态.
 */
export function removeSessionFromChat(sessionId: string): void {
  removeSessionSubscription(sessionId);
  // Presentation Claim 持有这一轮的 Speech 取消函数, 这里一次调用同时停止桌宠表现和实时语音.
  sessionPresentation.cancelSession(sessionId);
  useSessionActivityStore.getState().evictSession(sessionId);
  useTurnStore.getState().evictSession(sessionId);
  useSessionHistoryStore.getState().evictSession(sessionId);
  useChatDraftStore.getState().evictSession(sessionId);
  useChatNavigationStore.getState().evictSession(sessionId);
  useSessionPanelStore.getState().removeSessionLayout(sessionId);
  useSubagentStore.getState().evictSession(sessionId);
  useTaskStore.getState().evictSession(sessionId);
  useBackgroundProcessStore.getState().clearSession(sessionId);
}
