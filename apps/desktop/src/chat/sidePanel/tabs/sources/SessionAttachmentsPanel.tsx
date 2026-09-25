// 展示当前 Session 的全部持久附件(图片/粘贴文本两本账合并),点击打开预览标签。
import { useEffect, type CSSProperties, type JSX } from 'react';
import { Button, ScrollArea } from '@ema-agent/ui';

import type { SessionAttachmentsResult } from '../../../../api/sessions.js';
import { useSessionAttachmentStore } from '../../../../stores/sessionAttachment.js';
import {
  sessionSourceTab,
  useSessionPanelStore,
} from '../../../../stores/sessionPanel.js';

type SessionAttachmentItem = SessionAttachmentsResult['attachments'][number];

const EMPTY_ATTACHMENTS: SessionAttachmentItem[] = [];

function attachmentIcon(item: SessionAttachmentItem): string {
  return item.kind === 'image' ? 'i-lucide:image' : 'i-lucide:clipboard-paste';
}

function attachmentTitle(item: SessionAttachmentItem): string {
  return item.kind === 'image' ? (item.name ?? '剪贴板图片') : '粘贴文本';
}

export function SessionAttachmentsPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const openTab = useSessionPanelStore((state) => state.openTab);
  const attachments = useSessionAttachmentStore((state) =>
    sessionId ? state.bySession.get(sessionId) ?? EMPTY_ATTACHMENTS : EMPTY_ATTACHMENTS,
  );
  const loadState = useSessionAttachmentStore((state) =>
    sessionId ? state.loadStateBySession.get(sessionId) : undefined,
  );

  useEffect(() => {
    if (!sessionId) return;
    void useSessionAttachmentStore.getState().loadForSession(sessionId, true).catch(() => {});
  }, [sessionId]);

  if (!sessionId) return <EmptyState icon="i-lucide:message-square-off" text="请先选择会话" />;
  if (loadState?.status === 'loading' && attachments.length === 0) {
    return <EmptyState icon="i-lucide:loader-circle animate-spin" text="正在读取附件…" />;
  }
  if (loadState?.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <span className="i-lucide:cloud-alert text-2xl text-[var(--ema-danger)]" aria-hidden />
        <p className="text-xs text-[var(--ema-danger)]">{loadState.error}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void useSessionAttachmentStore.getState().loadForSession(sessionId, true).catch(() => {})}
        >
          重新加载
        </Button>
      </div>
    );
  }
  if (attachments.length === 0) return <EmptyState icon="i-lucide:paperclip" text="当前会话还没有附件" />;

  return (
    <div className="flex h-full flex-col">
      {loadState?.status === 'stale' && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] bg-[var(--ema-warning-muted)] text-[var(--ema-warning)]">
          <span className="i-lucide:triangle-alert" aria-hidden />
          刷新失败，正在显示上一次结果
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        {attachments.map((attachment, index) => (
          <div key={attachment.path} className="ema-stagger-in-swift" style={{ '--stagger-i': index } as CSSProperties}>
          <button
            className="flex w-full items-start gap-2.5 border-b border-[var(--ema-border)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--ema-surface-2)]"
            onClick={() => openTab(sessionId, sessionSourceTab(attachment.path))}
          >
            <span className={`${attachmentIcon(attachment)} mt-0.5 shrink-0 text-base text-[var(--ema-primary)]`} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-[var(--ema-text-primary)]" title={attachmentTitle(attachment)}>
                {attachmentTitle(attachment)}
              </span>
              <span className="mt-0.5 block truncate text-[10px] font-mono text-[var(--ema-text-tertiary)]">
                {attachment.path}
              </span>
              <time className="mt-0.5 block text-[10px] text-[var(--ema-text-tertiary)]" dateTime={new Date(attachment.createdAt).toISOString()}>
                {new Date(attachment.createdAt).toLocaleString()}
              </time>
            </span>
            <span className="i-lucide:chevron-right mt-1 shrink-0 text-xs text-[var(--ema-text-tertiary)]" aria-hidden />
          </button>
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: string; text: string }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <span className={`${icon} text-3xl opacity-25 text-[var(--ema-primary)]`} aria-hidden />
      <p className="text-xs text-[var(--ema-text-tertiary)]">{text}</p>
    </div>
  );
}
