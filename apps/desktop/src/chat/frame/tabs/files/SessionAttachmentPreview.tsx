// 在工作区右侧槽中读取并展示已落库的 Session 附件。
import { useEffect, useState, type JSX } from 'react';
import { ScrollArea, Spinner } from '@ema-agent/ui';
import { sessionsApi } from '../../../../api/sessions.js';
import { useSessionAttachmentStore } from '../../../../stores/sessionAttachment.js';

export function SessionAttachmentPreview({ sessionId, attachmentId }: {
  sessionId: string;
  attachmentId: string;
}): JSX.Element {
  const attachment = useSessionAttachmentStore(state =>
    state.bySession.get(sessionId)?.find(item => item.id === attachmentId),
  );
  const [blob, setBlob] = useState<Blob | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void useSessionAttachmentStore.getState().loadForSession(sessionId).catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    setBlob(null);
    setText(null);
    setUrl(null);
    setError(null);
    void sessionsApi.readAttachment(sessionId, attachmentId)
      .then(response => response.blob())
      .then(async value => {
        if (disposed) return;
        setBlob(value);
        if (value.type.startsWith('text/') || value.type === 'application/json') {
          setText(await value.text());
          return;
        }
        objectUrl = URL.createObjectURL(value);
        setUrl(objectUrl);
      })
      .catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : '附件读取失败'); });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, attachmentId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--ema-border)] px-3 py-2">
        <span className="i-lucide:paperclip text-sm text-[var(--ema-text-tertiary)]" aria-hidden />
        <span className="truncate text-xs text-[var(--ema-text-primary)]">{attachment?.name ?? '附件'}</span>
      </div>
      <ScrollArea orientation="both" className="flex-1" viewportClassName="p-3">
        {!blob && !error && <div className="flex justify-center py-8"><Spinner size="sm" /></div>}
        {error && <p className="py-8 text-center text-xs text-[var(--ema-danger)]">{error}</p>}
        {text !== null && <pre className="whitespace-pre-wrap text-xs text-[var(--ema-text-secondary)]">{text}</pre>}
        {url && blob?.type.startsWith('image/') && <img src={url} alt={attachment?.name ?? '附件'} className="mx-auto max-w-full rounded-lg" />}
        {url && blob?.type.startsWith('audio/') && <audio src={url} controls className="w-full" />}
        {url && blob?.type.startsWith('video/') && <video src={url} controls className="max-h-full max-w-full" />}
        {url && blob?.type === 'application/pdf' && <iframe src={url} title={attachment?.name ?? 'PDF'} className="h-[70vh] w-full border-0" />}
        {url && !blob?.type.startsWith('image/') && !blob?.type.startsWith('audio/') && !blob?.type.startsWith('video/') && blob?.type !== 'application/pdf' && (
          <p className="py-8 text-center text-xs text-[var(--ema-text-tertiary)]">该文件类型不能在应用内预览</p>
        )}
      </ScrollArea>
    </div>
  );
}
