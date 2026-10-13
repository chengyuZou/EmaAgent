import { useEffect, useState, type JSX } from 'react';
import { ScrollArea, Spinner } from '@ema-agent/ui';
import { sessionsApi } from '../../../../api/sessions.js';
import { useSessionAttachmentStore } from '../../../../stores/sessionAttachment.js';
import { AttachmentImagePreview } from '../../../../lib/images/attachmentImagePreview.js';

const TEXT_PREVIEW_MAX_CHARS = 50 * 1024;

export function SessionAttachmentPreview({ sessionId, attachmentPath }: {
  sessionId: string;
  attachmentPath: string;
}): JSX.Element {
  const entry = useSessionAttachmentStore(state =>
    state.bySession.get(sessionId)?.find(item => item.path === attachmentPath),
  );
  const loadStatus = useSessionAttachmentStore(state => state.loadStateBySession.get(sessionId)?.status);

  useEffect(() => {
    // 从消息直接打开附件时, 目录可能尚未加载. 复用列表中的 kind, 不再为判断类型先下载一次内容.
    void useSessionAttachmentStore.getState().loadForSession(sessionId).catch(() => {});
  }, [sessionId]);

  let title = attachmentPath.split(/[\\/]/).pop() ?? attachmentPath;
  if (entry?.kind === 'image') {
    title = entry.name ?? '剪贴板图片';
  } else if (entry?.kind === 'pasted_text') {
    title = '粘贴文本';
  }

  let content: JSX.Element;
  if (entry?.kind === 'image') {
    content = (
      <AttachmentImagePreview
        key={attachmentPath}
        sessionId={sessionId}
        path={attachmentPath}
        alt={title}
      />
    );
  } else if (entry?.kind === 'pasted_text') {
    content = <AttachmentTextPreview key={attachmentPath} sessionId={sessionId} path={attachmentPath} />;
  } else if (loadStatus === 'ready' || loadStatus === 'error' || loadStatus === 'stale') {
    content = <MissingAttachment />;
  } else {
    content = <div className="flex justify-center py-10"><Spinner size="md" /></div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--ema-border)] shrink-0">
        <span className="text-xs font-semibold text-[var(--ema-text-primary)] truncate">{title}</span>
        <span className="text-[10px] font-mono text-[var(--ema-text-tertiary)] truncate">
          {attachmentPath}
        </span>
      </div>
      <ScrollArea className="flex-1 p-3">{content}</ScrollArea>
    </div>
  );
}

function AttachmentTextPreview({ sessionId, path }: {
  readonly sessionId: string;
  readonly path: string;
}): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setText(null);
    setFailed(false);
    let cancelled = false;
    void sessionsApi.readAttachmentContent(sessionId, path)
      .then(response => response.text())
      .then(raw => {
        if (cancelled) {
          return;
        }
        if (raw.length > TEXT_PREVIEW_MAX_CHARS) {
          setText(raw.slice(0, TEXT_PREVIEW_MAX_CHARS) + '\n\n…(已截断,完整内容见文件)');
        } else {
          setText(raw);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);

  if (failed) {
    return <MissingAttachment />;
  }
  if (text === null) {
    return <div className="flex justify-center py-10"><Spinner size="md" /></div>;
  }
  return (
    <pre className="ema-material-reading rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all text-[var(--ema-text-secondary)]">
      {text}
    </pre>
  );
}

function MissingAttachment(): JSX.Element {
  return <p className="text-xs text-[var(--ema-text-tertiary)]">附件文件已不存在或无法读取。</p>;
}
