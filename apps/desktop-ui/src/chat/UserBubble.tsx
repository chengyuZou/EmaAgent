/** UserBubble — right-aligned user message. Layout from AIRI user-item.vue, colors original. */
import { useState, type ChangeEvent, type JSX } from 'react';
import { Button, IconButton, Textarea } from '@ema-agent/ui';
import { Markdown } from '../markdown/renderer.js';
import type { ChatHistoryItem } from '../stores/conversation-store.js';
import { useConversationStore } from '../stores/conversation-store.js';
import { useSessionStore } from '../stores/session-store.js';
import { AttachmentChip } from './AttachmentChip.js';
import { ForkButton } from './ForkButton.js';
import { DeleteTurnButton } from './DeleteTurnButton.js';
import { findEditForkPoint } from './edit-utils.js';
// 9.D: <N/M> 分支兄弟导航先注释掉——siblings<2 不显示 + branchData 刷新时序问题,
// 底层未修前用户切分支走 Branch 面板。组件代码保留,修好 9.D 再恢复。
// import { BranchSiblingNav } from './BranchSiblingNav.js';

export interface UserBubbleProps {
  message: ChatHistoryItem;
  label?:  string;
}

export function UserBubble({ message }: UserBubbleProps): JSX.Element {
  const attachments = message.attachments ?? [];
  const hasTurnId = !!message.turnId;
  const viewedId  = useConversationStore((s) => s.viewedSessionId);

  // ── 行内编辑分叉(DeepSeek 式): 铅笔 → 行内编辑框 → 发送时从前驱 turn 分叉出新分支 ──
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState('');
  const [sending, setSending] = useState(false);

  // fork 点在点击时取快照即可, 不用订阅; 整个会话首个 turn 没有可分叉点, 隐藏铅笔。
  const forkPoint = hasTurnId && viewedId
    ? findEditForkPoint(
        useConversationStore.getState().messages.get(viewedId as string) ?? [],
        message.turnId as string,
        useConversationStore.getState().branchDataBySession.get(viewedId as string),
      )
    : null;
  const canEdit = hasTurnId && forkPoint !== null && !editing;

  const startEdit = (): void => {
    setDraft(message.content);
    setEditing(true);
  };

  const handleSendEdit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !viewedId || !forkPoint) return;
    setSending(true);
    try {
      // 复用"标记-发送"(F-052): armFork 后 sendMessage 会先 forkBranch 再发送,
      // 编辑后的文本成为新分支的第一个 turn; 原消息留在旧分支不动。
      const mode = useSessionStore.getState().sessionModes.get(viewedId as string)?.mode ?? 'chat';
      useConversationStore.getState().armFork(forkPoint);
      setEditing(false);
      await useConversationStore.getState().sendMessage(viewedId, { text, mode });
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
        ) : (
          <div className="rounded-2xl rounded-br-md px-5 py-3 border text-sm break-words bg-[var(--ema-surface-2)] border-[var(--ema-border)] text-[var(--ema-text-secondary)]">
            <Markdown source={message.content} />
          </div>
        )}

        {/* ── 折叠 footer：fork / 编辑分叉 / 删除 + 分支兄弟导航 ──
            ema-collapsible 双向折叠（grid-rows 0fr↔1fr + opacity），DOM 常驻不 unmount。
            有 turnId 展开（分支操作是完成态），无 turnId 折叠。 */}
        <div
          className="ema-collapsible"
          style={{ gridTemplateRows: hasTurnId && !editing ? '1fr' : '0fr', opacity: hasTurnId && !editing ? 1 : 0 }}
        >
          <div className="flex items-center justify-end gap-1 text-[11px] overflow-hidden text-[var(--ema-text-tertiary)]">
            {message.turnId && <ForkButton turnId={message.turnId} />}
            {canEdit && (
              <IconButton
                variant="default"
                size="sm"
                icon="i-lucide:pencil"
                label="编辑并分叉"
                className="opacity-30 hover:opacity-80"
                onClick={startEdit}
              />
            )}
            {message.turnId && <DeleteTurnButton turnId={message.turnId} />}
            {/* 9.D: <N/M> 导航注释掉,切分支走 Branch 面板。修好 9.D 再恢复。 */}
            {/* {message.turnId && <BranchSiblingNav turnId={message.turnId} />} */}
          </div>
        </div>
      </div>
    </div>
  );
}
