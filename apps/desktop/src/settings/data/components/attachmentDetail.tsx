import { useCallback, useEffect, useState, type JSX } from 'react';
import { IconButton } from '@ema-agent/ui';
import { SessionAttachmentsPanel } from '../../../chat/sidePanel/tabs/sources/SessionAttachmentsPanel.js';
import { SessionAttachmentPreview } from '../../../chat/sidePanel/tabs/sources/SessionAttachmentPreview.js';
import { useSessionAttachmentStore } from '../../../stores/sessionAttachment.js';
import { subscribeSystemEvent } from '../../../lib/events/systemEventDispatcher.js';

export function AttachmentDetail({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const [path, setPath] = useState<string | null>(null);
  const open = useCallback((next: string) => setPath(next), []);
  useEffect(() => subscribeSystemEvent(event => {
    if (event.type === 'attachments_changed' && event.sessionId === sessionId) {
      // 更新目录不改变已打开的附件. 内容由现有预览组件按需读取.
      void useSessionAttachmentStore.getState().loadForSession(sessionId, true).catch(() => {});
    }
  }), [sessionId]);
  if (!path) {
    return <SessionAttachmentsPanel sessionId={sessionId} onOpenAttachment={open} />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--ema-border)] px-3 py-2">
        <IconButton
          label="返回附件列表"
          icon="i-lucide:arrow-left"
          shape="rounded"
          variant="ghost"
          size="sm"
          onClick={() => setPath(null)}
        />
        <span className="min-w-0 truncate font-mono text-xs text-[var(--ema-text-secondary)]">{path}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SessionAttachmentPreview sessionId={sessionId} attachmentPath={path} />
      </div>
    </div>
  );
}
