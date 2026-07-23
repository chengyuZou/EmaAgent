// 渲染用户消息，并允许用户只重写当前 Session 的最后一轮。
import { useRef, useState, type ChangeEvent, type JSX } from 'react';
import { Button, IconButton, Textarea } from '@ema-agent/ui';
import type { SessionId, TurnId } from '@ema-agent/ids';
import { Markdown } from '../markdown/renderer.js';
import { sessionsApi } from '../api/sessions.js';
import { showToast } from '../lib/toast.js';
import type { ChatHistoryItem } from '../stores/conversation-store.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { AttachmentChip } from './AttachmentChip.js';

function editErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '重新发送失败';
  if (error.message === 'turn_has_persistent_task') {
    return '该轮已经创建持久任务，不能原地重写；请从上一条回复创建新会话';
  }
  if (error.message === 'turn_not_latest') return '只能重新编辑当前会话的最后一轮';
  if (error.message === 'turn_running') return '该轮仍在运行，请先停止后再编辑';
  return error.message;
}

export interface UserBubbleProps {
  message: ChatHistoryItem;
  canEdit?: boolean;
}

export function UserBubble({ message, canEdit = false }: UserBubbleProps): JSX.Element {
  const attachments = message.attachments ?? [];
  const hasTurnId = !!message.turnId;
  const viewedId  = useConversationStore((s) => s.viewedSessionId);

  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState('');
  const [sending, setSending] = useState(false);
  const rewoundRef = useRef(false);
  const showEdit = canEdit && hasTurnId && !editing && message.content.trim().length > 0;

  const startEdit = (): void => {
    setDraft(message.content);
    setEditing(true);
  };

  const handleSendEdit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !viewedId || !message.turnId) return;
    setSending(true);
    try {
      if (!rewoundRef.current) {
        await sessionsApi.rewindLastTurn(viewedId, message.turnId as TurnId);
        rewoundRef.current = true;
      }
      const session = useSessionStore.getState().sessions.byId.get(viewedId as string);
      await useConversationStore.getState().sendMessage(viewedId, {
        text,
        executionProfile: session?.executionProfile ?? 'chat',
        narrativePolicy: session?.narrativePolicy ?? 'auto',
      });
      setEditing(false);

      // 新 Turn 已被接受后再刷新，避免回滚成功但重发失败时丢失编辑框。
      useConversationStore.setState((state) => {
        const messages = new Map(state.messages);
        messages.delete(viewedId as string);
        const loaded = new Set(state.loadedMessageSessions);
        loaded.delete(viewedId as string);
        return { messages, loadedMessageSessions: loaded };
      });
      await useConversationStore.getState().loadMessages(viewedId as SessionId);
    } catch (error) {
      showToast(
        editErrorMessage(error),
        { variant: 'danger' },
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex ml-12 flex-row-reverse ema-bubble-in">
      <div className="flex flex-col min-w-20 max-w-full items-end">
        {/* Attachment chips — shown above the message bubble when present */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 mb-1.5 max-w-full">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} />
            ))}
          </div>
        )}

        {editing ? (
          <div className="w-full rounded-2xl px-3 py-2 border bg-[var(--ema-surface-2)] border-[var(--ema-border)]">
            <Textarea
              containerless
              autoGrow
              className="w-full bg-transparent text-sm resize-none focus:outline-none text-[var(--ema-text-secondary)]"
              rows={3}
              value={draft}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-[var(--ema-text-tertiary)]">
              重新发送会替换本轮聊天记录，但不会撤销已经执行的文件、网络或记忆操作。
            </p>
            <div className="flex justify-end gap-2 mt-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!draft.trim() || sending}
                onClick={() => void handleSendEdit()}
              >
                发送
              </Button>
            </div>
          </div>
        ) : message.content.trim().length > 0 ? (
          <div className="rounded-2xl rounded-br-md px-5 py-3 border text-sm break-words bg-[var(--ema-surface-2)] border-[var(--ema-border)] text-[var(--ema-text-secondary)]">
            <Markdown source={message.content} />
          </div>
        ) : null}

        {/* 只有最新一条用户消息可回滚重发，历史消息不提供破坏性删除。 */}
        <div
          className="ema-collapsible"
          style={{ gridTemplateRows: showEdit ? '1fr' : '0fr', opacity: showEdit ? 1 : 0 }}
        >
          <div className="flex items-center justify-end gap-1 text-[11px] overflow-hidden text-[var(--ema-text-tertiary)]">
            {showEdit && (
              <IconButton
                variant="default"
                size="sm"
                icon="i-lucide:pencil"
                label="重写最后一轮（不撤销已执行操作）"
                className="opacity-30 hover:opacity-80"
                onClick={startEdit}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
