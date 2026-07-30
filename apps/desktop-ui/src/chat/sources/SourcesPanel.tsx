// Sources 标签内容：展示当前 Session 的持久化附件、磁盘状态，并安全交给操作系统打开。
import { useEffect, useState, type JSX } from 'react';
import { Button, ScrollArea } from '@ema-agent/ui';
import type { SessionId } from '@ema-agent/ids';
import type { SessionAttachmentFileStatus, SessionAttachmentWire } from '@ema-agent/session';
import { tauriBridge } from '../../lib/tauri-bridge.js';
import { useSessionAttachmentStore } from '../../stores/session-attachment-store.js';

const EMPTY_ATTACHMENTS: SessionAttachmentWire[] = [];

const STATUS_META: Record<SessionAttachmentFileStatus, {
  label: string;
  className: string;
  icon: string;
}> = {
  available: {
    label: '可用',
    className: 'text-[var(--ema-success)]',
    icon: 'i-lucide:circle-check',
  },
  modified: {
    label: '原文件已修改',
    className: 'text-[var(--ema-warning)]',
    icon: 'i-lucide:triangle-alert',
  },
  missing: {
    label: '原文件已丢失',
    className: 'text-[var(--ema-danger)]',
    icon: 'i-lucide:file-x',
  },
  inaccessible: {
    label: '无法访问',
    className: 'text-[var(--ema-danger)]',
    icon: 'i-lucide:shield-alert',
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function attachmentIcon(attachment: SessionAttachmentWire): string {
  if (attachment.mimeType.startsWith('image/')) return 'i-lucide:image';
  if (attachment.mimeType.startsWith('audio/')) return 'i-lucide:audio-lines';
  if (attachment.mimeType === 'application/pdf') return 'i-lucide:file-text';
  return 'i-lucide:paperclip';
}

function AttachmentRow({ attachment }: { attachment: SessionAttachmentWire }): JSX.Element {
  const [openError, setOpenError] = useState<string | null>(null);
  const status = STATUS_META[attachment.fileStatus];
  const canOpen = Boolean(attachment.fileHandle)
    && (attachment.fileStatus === 'available' || attachment.fileStatus === 'modified');

  const open = async (): Promise<void> => {
    if (!canOpen) return;
    setOpenError(null);
    try {
      if (!attachment.fileHandle) throw new Error('该历史附件没有可用的文件授权');
      await tauriBridge.openAuthorizedFile(attachment.fileHandle);
    } catch {
      setOpenError('系统未能打开此文件');
    }
  };

  return (
    <div className="group px-3 py-2.5 border-b border-[var(--ema-border)] hover:bg-[var(--ema-surface-2)] transition-colors">
      <div className="flex items-start gap-2.5">
        <span
          className={`${attachmentIcon(attachment)} mt-0.5 text-base shrink-0 text-[var(--ema-primary)]`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-medium text-[var(--ema-text-primary)]" title={attachment.name}>
              {attachment.name}
            </span>
            <span className={`ml-auto inline-flex items-center gap-1 shrink-0 text-[10px] ${status.className}`}>
              <span className={status.icon} aria-hidden />
              {status.label}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--ema-text-tertiary)]">
            <span>{formatBytes(attachment.size)}</span>
            <span>·</span>
            <time dateTime={new Date(attachment.createdAt).toISOString()}>
              {new Date(attachment.createdAt).toLocaleString()}
            </time>
          </div>
          <p className="mt-1 truncate text-[10px] text-[var(--ema-text-tertiary)]">
            已附加到对话
          </p>
          {openError && <p className="mt-1 text-[10px] text-[var(--ema-danger)]">{openError}</p>}
        </div>
        <Button
          variant="ghost"
          className="size-7 p-0 shrink-0 opacity-70 group-hover:opacity-100"
          disabled={!canOpen}
          onClick={() => void open()}
          title={canOpen ? '使用系统默认程序打开' : status.label}
          aria-label={`打开 ${attachment.name}`}
        >
          <span className="i-lucide:external-link text-sm" aria-hidden />
        </Button>
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
      .loadForSession(sessionId as SessionId, true)
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
            .loadForSession(sessionId as SessionId, true)
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
