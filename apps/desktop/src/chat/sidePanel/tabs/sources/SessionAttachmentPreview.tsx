// Session 附件预览:按 path 找条目、经内容端点读内容。
// 图片显示图(点开原图),粘贴文本显示 txt 全文(截断 50KB),其余显示路径信息。
import { useEffect, useState, type JSX } from 'react';
import { ScrollArea, Spinner } from '@ema-agent/ui';
import { sessionsApi } from '../../../../api/sessions.js';
import { useSessionAttachmentStore } from '../../../../stores/sessionAttachment.js';

const TEXT_PREVIEW_MAX_BYTES = 50 * 1024;

export function SessionAttachmentPreview({ sessionId, attachmentPath }: {
  sessionId: string;
  attachmentPath: string;
}): JSX.Element {
  const entry = useSessionAttachmentStore(state =>
    state.bySession.get(sessionId)?.find(item => item.path === attachmentPath),
  );
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setUrl(null);
    setText(null);
    setFailed(false);
    let cancelled = false;
    void sessionsApi.readAttachmentContent(sessionId, attachmentPath)
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setFailed(true);
          return;
        }
        const contentType = response.headers.get('Content-Type') ?? '';
        if (contentType.startsWith('image/')) {
          setUrl(URL.createObjectURL(await response.blob()));
        } else {
          const raw = await response.text();
          setText(raw.length > TEXT_PREVIEW_MAX_BYTES
            ? `${raw.slice(0, TEXT_PREVIEW_MAX_BYTES)}\n\n…(已截断,完整内容见文件)`
            : raw);
        }
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [sessionId, attachmentPath]);

  const title = entry?.kind === 'image'
    ? (entry.name ?? '剪贴板图片')
    : entry?.kind === 'pasted_text'
      ? '粘贴文本'
      : (attachmentPath.split(/[\\/]/).pop() ?? attachmentPath);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--ema-border)] shrink-0">
        <span className="text-xs font-semibold text-[var(--ema-text-primary)] truncate">{title}</span>
        <span className="text-[10px] font-mono text-[var(--ema-text-tertiary)] truncate">
          {attachmentPath}
        </span>
      </div>
      <ScrollArea className="flex-1 p-3">
        {failed && (
          <p className="text-xs text-[var(--ema-text-tertiary)]">附件文件已不存在或无法读取。</p>
        )}
        {!failed && !url && !text && (
          <div className="flex justify-center py-10"><Spinner size="md" /></div>
        )}
        {url && <img src={url} alt={title} className="mx-auto max-w-full rounded-lg" />}
        {text !== null && (
          <pre className="text-xs font-mono whitespace-pre-wrap break-all text-[var(--ema-text-secondary)]">
            {text}
          </pre>
        )}
      </ScrollArea>
    </div>
  );
}
