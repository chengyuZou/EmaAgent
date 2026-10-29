import { useRef, useState } from 'react';
import { ConfirmDialog, PromptDialog } from '@ema-agent/ui';
import { ServerApiError } from '../../../api/client.js';
import type { SessionListItem } from '../../../api/sessions.js';
import { SessionRequestError, sessionWebSocket } from '../../../api/sessionWebSocket.js';
import { useMainNavigationStore } from '../../../layout/navigation.js';
import { useSessionStore } from '../../../stores/session.js';
import { useSessionActivityStore } from '../../../stores/sessionActivity.js';
import { ensureSessionSubscription } from '../../session/sessionSubscriptions.js';
import { removeSessionFromChat } from '../../session/removeSessionFromChat.js';
import { notifySessionCompletion } from '../../../lib/notifications/sessionCompletionNotifications.js';
import { showToast } from '../../../lib/notifications/toast.js';

const COMPACT_ERRORS: Record<string, string> = {
  session_busy: '当前会话正忙, 请稍后再试',
  compact_below_threshold: '历史还短, 不需要压缩',
  nothing_to_compact: '没有可压缩的内容',
  provider_not_configured: '未配置可用模型',
  compact_failed: '压缩失败, 请重试',
};

export function useInputCommands(
  viewedId: string | null,
  viewedSession: SessionListItem | undefined,
  onGoalCommand: () => void,
) {
  const [compacting, setCompacting] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<Pick<SessionListItem, 'id' | 'title'> | null>(null);
  const archivePending = useRef(false);

  async function archive(session: Pick<SessionListItem, 'id' | 'title'>): Promise<void> {
    if (archivePending.current) return;
    archivePending.current = true;
    try {
      await useSessionStore.getState().archiveSession(session.id);
      removeSessionFromChat(session.id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '归档失败', { variant: 'danger' });
    } finally {
      archivePending.current = false;
    }
  }

  async function runCompact(): Promise<void> {
    if (
      !viewedId
      || compacting
      || useSessionActivityStore.getState().bySession.get(viewedId)?.running != null
    ) return;
    setCompacting(true);
    // 本次手动请求的通知身份, 自动压缩不走此入口. 切换聊天后仍通知最初发起的 Session.
    const notificationId = crypto.randomUUID();
    try {
      ensureSessionSubscription(viewedId);
      const result = await sessionWebSocket.startCompaction(viewedId);
      if (result.status === 'cancelled') {
        showToast('压缩已取消', { variant: 'info' });
      } else {
        void notifySessionCompletion(viewedId, notificationId, 'compactCompleted');
        showToast(`已压缩 ${result.beforeTokens} → ${result.afterTokens} tokens`, { variant: 'success' });
      }
    } catch (error) {
      const code = error instanceof ServerApiError || error instanceof SessionRequestError
        ? error.code
        : undefined;
      void notifySessionCompletion(viewedId, notificationId, 'compactFailed');
      let message = '压缩失败';
      if (code && COMPACT_ERRORS[code]) message = COMPACT_ERRORS[code];
      else if (error instanceof Error) message = error.message;
      showToast(message, { variant: 'danger' });
    } finally {
      setCompacting(false);
    }
  }

  async function runCommand(name: string): Promise<void> {
    const sessions = useSessionStore.getState();
    if (name === 'compact') return runCompact();
    if (name === 'new') {
      useMainNavigationStore.getState().openNewSession();
      return;
    }
    if (!viewedId) return;
    if (name === 'goal') {
      onGoalCommand();
      return;
    }
    if (name === 'fork') {
      useMainNavigationStore.getState().viewSession(await sessions.forkSession(viewedId));
      return;
    }
    if (name === 'rename') {
      setRenameOpen(true);
      return;
    }
    if (name === 'pin') return sessions.pinSession(viewedId, !(viewedSession?.pinned ?? false));
    if (name === 'archive') {
      if (viewedSession) setPendingArchive({ id: viewedSession.id, title: viewedSession.title });
      return;
    }
    showToast(`未知命令: /${name}`, { variant: 'warning' });
  }

  const renameDialog = renameOpen && viewedSession ? (
    <PromptDialog
      open
      title="重命名聊天"
      message="为当前聊天输入新标题."
      initialValue={viewedSession.title ?? ''}
      placeholder="聊天标题"
      onConfirm={(value) => {
        setRenameOpen(false);
        if (viewedId && value.trim()) {
          void useSessionStore.getState().renameSession(viewedId, value.trim());
        }
      }}
      onCancel={() => setRenameOpen(false)}
    />
  ) : null;

  const commandDialogs = (
    <>
      {renameDialog}
      <ConfirmDialog
        open={pendingArchive !== null}
        title="归档会话"
        message={`确定归档会话"${pendingArchive?.title || '新对话'}"? 如有正在运行的工作, 确认后会立即停止主任务, 子代理, 命令和语音, 取消 Goal 及排队输入. 历史会保留, 取消归档不会自动恢复执行.`}
        confirmText="归档"
        danger={false}
        onConfirm={() => {
          if (!pendingArchive) return;
          const session = pendingArchive;
          setPendingArchive(null);
          void archive(session);
        }}
        onCancel={() => setPendingArchive(null)}
      />
    </>
  );

  return { compacting, runCommand, commandDialogs };
}
