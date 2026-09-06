// 渲染用户消息与待发送输入：skill_reference 块渲染为 Skill chip（展示稳定 key），
// 附件走线上投影，正文为 text 块。
import { useRef, useState, type ChangeEvent, type JSX } from 'react';
import { Button, IconButton, Textarea } from '@ema-agent/ui';

import { Markdown } from '../../markdown/renderer.js';
import { sessionsApi } from '../../api/sessions.js';
import { showToast } from '../../lib/toast.js';
import type { SessionHistoryMessage } from '../../api/sessions.js';
import type {
  AttachmentReferenceBlock,
  SkillReferenceBlock,
  UserBlock,
} from '@ema-agent/session';
import type { PendingInput } from '../state/messages.js';
import { useMessages } from '../state/messages.js';
import { useCurrentSession } from '../state/currentSession.js';
import { useSessionStore } from '../../stores/session.js';
import { sendMessage } from '../state/turnRunner.js';
import { chipMeta } from './AttachmentChip.js';
import { formatTurnTime } from '../history/workGroups.js';
import { messageText } from '../history/turnGroups.js';
import { sessionAttachmentTab, useDockTabs } from '../frame/dockTabs.js';

function editErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '重新发送失败';
  if (error.message === 'turn_has_persistent_task') {
    return '该轮已经创建持久任务，不能原地重写；请从上一条回复创建新会话';
  }
  if (error.message === 'turn_not_latest') return '只能重新编辑当前会话的最后一轮';
  if (error.message === 'turn_running') return '该轮仍在运行，请先停止后再编辑';
  return error.message;
}

/** 历史附件 chip 的展示事实:名称取 path 的 basename,图标按扩展名粗判。 */
function attachmentChipDisplay(filePath: string): { name: string; icon: string; color: string } {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const mime = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)
    ? `image/${ext === 'jpg' ? 'jpeg' : ext}`
    : ext === 'pdf' ? 'application/pdf' : '';
  return { name, ...chipMeta(mime, name) };
}

export interface UserBubbleProps {
  message: SessionHistoryMessage;
  canEdit?: boolean;
}

export function UserBubble({ message, canEdit = false }: UserBubbleProps): JSX.Element {
  const content = messageText(message);
  // 附件卡置顶；正文按输入顺序走：text 段与 skill_reference chip 内联混排（用户放置的位置）。
  const attachments = Array.isArray(message.blocks)
    ? message.blocks.filter(
        (block): block is AttachmentReferenceBlock =>
          block.type === 'attachment_reference',
      )
    : [];
  const segments = Array.isArray(message.blocks)
    ? message.blocks.filter(
        (block): block is Extract<UserBlock, { type: 'text' }> | SkillReferenceBlock =>
          block.type === 'text' || block.type === 'skill_reference',
      )
    : [{ type: 'text' as const, text: content }];
  const hasTurnId = !!message.turnId;
  const viewedId = useCurrentSession((s) => s.viewedSessionId);

  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState('');
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const rewoundRef = useRef(false);
  const showEdit = canEdit && hasTurnId && !editing && content.trim().length > 0;

  const copyContent = (): void => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    });
  };

  const startEdit = (): void => {
    setDraft(content);
    setEditing(true);
  };

  const handleSendEdit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !viewedId || !message.turnId) return;
    setSending(true);
    try {
      if (!rewoundRef.current) {
        await sessionsApi.rewindLastTurn(viewedId, message.turnId);
        rewoundRef.current = true;
      }
      const session = useSessionStore.getState().sessions.byId.get(viewedId);
      await sendMessage({
        sessionId: viewedId,
        input: [{ type: 'text', text }],
        executionProfile: session?.executionProfile ?? 'chat',
        narrativePolicy: session?.narrativePolicy ?? 'auto',
      });
      setEditing(false);

      // 新 Turn 已被接受后再刷新，避免回滚成功但重发失败时丢失编辑框。
      await useMessages.getState().reloadMessages(viewedId);
    } catch (error) {
      showToast(editErrorMessage(error), { variant: 'danger' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex ml-12 flex-row-reverse ema-bubble-in">
      <div className="flex flex-col min-w-20 max-w-full items-end">
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 mb-1.5 max-w-full">
            {attachments.map((ref) => {
              const chip = attachmentChipDisplay(ref.path);
              return (
                <button
                  type="button"
                  key={ref.attachmentId}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] bg-[var(--ema-surface-2)] text-[var(--ema-text-tertiary)] border border-[var(--ema-border)]"
                  onClick={() => {
                    if (viewedId) useDockTabs.getState().openTab(viewedId, sessionAttachmentTab(ref.attachmentId));
                  }}
                >
                  <span className={`${chip.icon} text-[10px]`} style={{ color: chip.color }} aria-hidden />
                  {chip.name}
                </button>
              );
            })}
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
        ) : content.trim().length > 0 || segments.some((s) => s.type === 'skill_reference') ? (
          <div className="rounded-2xl rounded-br-md px-5 py-3 border text-sm break-words bg-[var(--ema-surface-2)] border-[var(--ema-border)] text-[var(--ema-text-secondary)]">
            {segments.map((segment, index) =>
              segment.type === 'skill_reference' ? (
                <span
                  key={`skill-${segment.path}-${index}`}
                  className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 mx-0.5 align-baseline text-[11px] bg-[var(--ema-info-muted)] text-[var(--ema-info)]"
                >
                  <span className="i-lucide:sparkles text-[10px]" aria-hidden />
                  {segment.name}
                </span>
              ) : (
                <span key={`text-${index}`} className="ema-md-inline">
                  <Markdown source={segment.text} />
                </span>
              ),
            )}
          </div>
        ) : null}

        {/* 只有最新一条用户消息可回滚重发，历史消息不提供破坏性删除。 */}
        <div className="flex items-center justify-end gap-1.5 text-[11px] text-[var(--ema-text-tertiary)]">
          <span className="opacity-50 tabular-nums">{formatTurnTime(message.createdAt)}</span>
          {content.trim().length > 0 && !editing && (
            <IconButton
              variant="default"
              size="sm"
              icon={copied ? 'i-lucide:check' : 'i-lucide:copy'}
              label="复制"
              className="opacity-30 hover:opacity-80"
              onClick={copyContent}
            />
          )}
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
  );
}

/** 已提交但尚未落库的用户输入：与用户气泡同形，Skill chip 直接展示稳定 key。 */
export function PendingBubble({ pending }: { pending: PendingInput }): JSX.Element {
  const attachmentParts = pending.parts.filter((part) => part.type === 'attachment');
  const bodyParts = pending.parts.filter((part) => part.type !== 'attachment');

  return (
    <div className="flex ml-12 flex-row-reverse ema-bubble-in opacity-80">
      <div className="flex flex-col min-w-20 max-w-full items-end">
        {attachmentParts.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5 mb-1.5 max-w-full">
            {attachmentParts.map((part, index) => {
              const displayName = part.attachment.name ?? part.attachment.sourcePath.split(/[\\/]/).pop() ?? '附件';
              const { icon, color } = chipMeta(part.attachment.mimeType ?? '', displayName);
              return (
                <span
                  key={`${part.attachment.sourcePath}-${index}`}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] bg-[var(--ema-surface-2)] text-[var(--ema-text-tertiary)] border border-[var(--ema-border)]"
                >
                  <span className={`${icon} text-[10px]`} style={{ color }} aria-hidden />
                  {displayName}
                </span>
              );
            })}
          </div>
        )}
        <div className="rounded-2xl rounded-br-md px-5 py-3 border text-sm break-words bg-[var(--ema-surface-2)] border-[var(--ema-border)] text-[var(--ema-text-secondary)]">
          {bodyParts.map((part, index) => {
            if (part.type === 'skill_reference') {
              return (
                <span
                  key={`skill-${part.path}-${index}`}
                  className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 mx-0.5 align-baseline text-[11px] bg-[var(--ema-info-muted)] text-[var(--ema-info)]"
                >
                  <span className="i-lucide:sparkles text-[10px]" aria-hidden />
                  {part.name}
                </span>
              );
            }
            return (
              <span key={`text-${index}`} className="ema-md-inline">
                <Markdown source={part.text} />
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
