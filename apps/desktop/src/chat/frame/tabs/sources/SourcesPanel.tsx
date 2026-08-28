// Sources 标签内容：展示当前 Session 的持久化附件清单。
// 传输层只携带展示字段（id/turnId/kind/name/mimeType/createdAt），路径与文件状态
// 按设计不进传输层，因此本面板不提供打开或磁盘状态展示。
import { useEffect, type JSX } from 'react';
import { Button, ScrollArea } from '@ema-agent/ui';

import type { SessionAttachmentsResult } from '../../../../api/sessions.js';
import { useSessionAttachmentStore } from '../../../../stores/sessionAttachment.js';

type SessionAttachmentItem = SessionAttachmentsResult['attachments'][number];

const EMPTY_ATTACHMENTS: SessionAttachmentItem[] = [];

function attachmentIcon(attachment: SessionAttachmentItem): string {
  if (attachment.mimeType.startsWith('image/')) return 'i-lucide:image';
  if (attachment.mimeType.startsWith('audio/')) return 'i-lucide:audio-lines';
  if (attachment.mimeType === 'application/pdf') return 'i-lucide:file-text';
  return 'i-lucide:paperclip';
}

function AttachmentRow({ attachment }: { attachment: SessionAttachmentItem }): JSX.Element {
  return (
    <div className="px-3 py-2.5 border-b border-[var(--ema-border)] hover:bg-[var(--ema-surface-2)] transition-colors">
      <div className="flex items-start gap-2.5">
        <span
          className={`${attachmentIcon(attachment)} mt-0.5 text-base shrink-0 text-[var(--ema-primary)]`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-[var(--ema-text-primary)]" title={attachment.name}>
            {attachment.name}
          </span>
          <div className="mt-1 text-[10px] text-[var(--ema-text-tertiary)]">
            <time dateTime={new Date(attachment.createdAt).toISOString()}>
              {new Date(attachment.createdAt).toLocaleString()}
            </time>
          </div>
          <p className="mt-1 truncate text-[10px] text-[var(--ema-text-tertiary)]">
            已附加到对话
          </p>
        </div>
      </div>
    </div>
  );
}

export function SourcesPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const attachments = useSessionAttachmentStore((state) =>
    sessionId ? state.bySession.get(sessionId) ?? EMPTY_ATTACHMENTS : EMPTY_ATTACHMENTS,
  );
  const loadState = useSessionAttachmentStore((state) =>
    sessionId ? state.loadStateBySession.get(sessionId) : undefined,
  );

  useEffect(() => {
    if (!sessionId) return;
    void useSessionAttachmentStore.getState()
      .loadForSession(sessionId, true)
      .catch(() => {});
  }, [sessionId]);

  if (!sessionId) {
    return <EmptyState icon="i-lucide:message-square-off" text="请先选择会话" />;
  }

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
          onClick={() => void useSessionAttachmentStore.getState()
            .loadForSession(sessionId, true)
            .catch(() => {})}
        >
          重新加载
        </Button>
      </div>
    );
  }

  if (attachments.length === 0) {
    return <EmptyState icon="i-lucide:paperclip" text="当前会话还没有附件" />;
  }

  return (
    <div className="flex h-full flex-col">
      {loadState?.status === 'stale' && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] bg-[var(--ema-warning-muted)] text-[var(--ema-warning)]">
          <span className="i-lucide:triangle-alert" aria-hidden />
          刷新失败，正在显示上一次结果
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        {attachments.map((attachment) => (
          <AttachmentRow key={attachment.id} attachment={attachment} />
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
