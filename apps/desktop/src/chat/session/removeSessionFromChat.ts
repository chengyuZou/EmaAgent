import { useSubagentStore } from '../../stores/subagent.js';
import { useBackgroundProcessStore } from '../../stores/backgroundProcess.js';
import { useChatDraftStore } from '../../stores/chatDraft.js';
import { useMainNavigationStore } from '../../layout/navigation.js';
import { useSessionHistoryStore } from '../../stores/sessionHistory.js';
import { useTurnStore } from '../../stores/turn.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useSessionPanelStore } from '../../stores/sessionPanel.js';
import { useTaskStore } from '../../stores/task.js';
import { removeSessionPlayback } from '../speech/turnSpeechPlayback.js';
import { removeSessionSpeechGeneration } from '../speech/turnSpeechGeneration.js';
import { removeSessionSubscription } from './sessionSubscriptions.js';

/**
 * 会话已经在服务端归档或删除后, 聊天界面才会调用这个入口.
 * 这些内存数据分属不同 Store, 但必须在同一个用户操作成功后一起
 * 移除, 否则再次打开同一会话会看到旧草稿, 侧面板或已断开的运行状态.
 */
export function removeSessionFromChat(sessionId: string): void {
  removeSessionSubscription(sessionId);
  removeSessionPlayback(sessionId);
  removeSessionSpeechGeneration(sessionId);
  useSessionActivityStore.getState().evictSession(sessionId);
  useTurnStore.getState().evictSession(sessionId);
  useSessionHistoryStore.getState().evictSession(sessionId);
  useChatDraftStore.getState().evictSession(sessionId);
  useMainNavigationStore.getState().evictSession(sessionId);
  useSessionPanelStore.getState().removeSessionLayout(sessionId);
  useSubagentStore.getState().evictSession(sessionId);
  useTaskStore.getState().evictSession(sessionId);
  useBackgroundProcessStore.getState().clearSession(sessionId);
}
