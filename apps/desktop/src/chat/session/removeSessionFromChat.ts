import { useSubagentStore } from '../../stores/subagent.js';
import { useBackgroundProcessStore } from '../../stores/backgroundProcess.js';
import { useChatDraftStore } from '../../stores/chatDraft.js';
import { useMainNavigationStore } from '../../layout/navigation.js';
import { useSessionHistoryStore } from '../../stores/sessionHistory.js';
import { useTurnStore } from '../../stores/turn.js';
import { useSessionActivityStore } from '../../stores/sessionActivity.js';
import { useSessionPanelStore } from '../../stores/sessionPanel.js';
import { useTaskStore } from '../../stores/task.js';
import { useSessionAttachmentStore } from '../../stores/sessionAttachment.js';
import { runWithToast } from '../../lib/notifications/toast.js';
import { removeSessionPlayback } from '../speech/turnSpeechPlayback.js';
import { removeSessionSpeechGeneration } from '../speech/turnSpeechGeneration.js';
import { removeSessionSubscription } from './sessionSubscriptions.js';
import { closeSessionTerminals } from '../sidePanel/tabs/terminal/terminalSessions.js';
import { cancelVoiceInput } from '../input/voice/voiceInput.js';

/**
 * 会话已经在服务端归档或删除后, 聊天界面才会调用这个入口.
 * 这些内存数据分属不同 Store, 但必须在同一个用户操作成功后一起
 * 移除, 否则再次打开同一会话会看到旧草稿, 侧面板或已断开的运行状态.
 */
export function removeSessionFromChat(sessionId: string): void {
  cancelVoiceInput(sessionId);
  // 先离开已删除的会话, 避免清空估算状态时又为它发起请求.
  useMainNavigationStore.getState().evictSession(sessionId);
  removeSessionSubscription(sessionId);
  removeSessionPlayback(sessionId);
  removeSessionSpeechGeneration(sessionId);
  useSessionActivityStore.getState().evictSession(sessionId);
  useTurnStore.getState().evictSession(sessionId);
  useSessionHistoryStore.getState().evictSession(sessionId);
  useChatDraftStore.getState().evictSession(sessionId);
  useSessionAttachmentStore.getState().evictSession(sessionId);
  // 标签消失前先释放 xterm 并请求宿主关闭 PTY, 不能只把仍在运行的终端藏起来.
  void runWithToast(closeSessionTerminals(sessionId), '关闭会话终端失败');
  useSessionPanelStore.getState().removeSessionLayout(sessionId);
  useSubagentStore.getState().evictSession(sessionId);
  useTaskStore.getState().evictSession(sessionId);
  useBackgroundProcessStore.getState().clearSession(sessionId);
}
