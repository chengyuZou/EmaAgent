/**
 * FilePreview - in-app 文件预览(像 Codex/Claude)。
 *
 * 点 FilesPanel 文件 -> 调 workspaceApi.readFile -> 按类型渲染:
 *   - md/mdx  -> Markdown 组件
 *   - 图片    -> <img src=data:mime;base64>
 *   - 文本    -> <pre> + highlight.js 语法高亮
 *   - 过大    -> 提示
 *   - 二进制  -> 提示
 * 顶部回退按钮(IconButton i-lucide:arrow-left)+ 文件名 + 大小。
 * 入场 ema-fade-in(style.css)。ScrollArea 包裹(@ema-agent/ui)。
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { IconButton, Markdown, ScrollArea, Spinner, highlightFile } from '@ema-agent/ui';
import { filesApi, type FileContent } from '../../../../api/workspaces.js';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export function FilePreview({ path, onBack }: { path: string; onBack: () => void }): JSX.Element {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error,  setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    filesApi.readFile(path)
      .then((c) => { if (!cancelled) setContent(c); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);

  const fileName = path.split(/[\\/]/).pop() ?? path;
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';

  return (
    <div className="ema-file-preview flex h-full flex-col ema-fade-in">
      {/* 顶栏:回退 + 文件名 + 大小 */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b shrink-0 border-[var(--ema-border)]">
        <IconButton
          size="sm"
          className="ema-chat-icon-btn"
          label="返回文件列表"
          icon="i-lucide:arrow-left"
          onClick={onBack}
        />
        <span className="flex-1 truncate text-xs font-mono text-[var(--ema-text-primary)]" title={path}>
          {fileName}
        </span>
        {content && 'size' in content && (
          <span className="text-[10px] shrink-0 tabular-nums text-[var(--ema-text-tertiary)]">
            {fmtSize(content.size)}
          </span>
        )}
      </div>

      {/* 内容区 */}
      <ScrollArea orientation="vertical" className="flex-1" viewportClassName="p-3">
        {loading && (
          <div className="flex justify-center py-8"><Spinner size="sm" /></div>
        )}
        {error && (
          <p className="text-xs text-center py-8 text-[var(--ema-danger)]">
            读取失败:{error}
          </p>
        )}
        {!loading && !error && content && <ContentBody content={content} ext={ext} />}
      </ScrollArea>
    </div>
  );
}

function ContentBody({ content, ext }: { content: FileContent; ext: string }): JSX.Element {
  if ('tooLarge' in content) {
    return (
      <p className="text-xs text-center py-8 text-[var(--ema-text-tertiary)]">
        文件过大({fmtSize(content.size)} 大于 {fmtSize(content.limit)}),请用外部程序打开
      </p>
    );
  }
  if ('binary' in content) {
    return (
      <p className="text-xs text-center py-8 text-[var(--ema-text-tertiary)]">
        二进制文件,无法 in-app 预览
      </p>
    );
  }
  if (content.encoding === 'base64') {
    return (
      <div className="flex items-center justify-center">
        <img
          src={`data:${content.mimeType};base64,${content.content}`}
          alt="preview"
          className="max-w-full h-auto rounded-lg bg-[var(--ema-surface-2)]"
        />
      </div>
    );
  }
  // text
  if (ext === 'md' || ext === 'mdx') {
    return <Markdown source={content.content} />;
  }
  return <CodePreview source={content.content} ext={ext} />;
}

function CodePreview({ source, ext }: { source: string; ext: string }): JSX.Element {
  const lines = useMemo(
    () => splitHighlightedLines(highlightFile(source.replace(/\r\n?/g, '\n'), ext)),
    [source, ext],
  );
  const gutterWidth = `${String(lines.length).length + 1}ch`;
  return (
    <div className="ema-material-code ema-font-mono min-w-0 p-2 text-xs">
      {lines.map((html, index) => (
        <div key={index} className="flex min-w-0 leading-[1.7]">
          <span
            className="shrink-0 select-none pr-2 text-right tabular-nums text-[var(--ema-text-tertiary)]"
            style={{ width: gutterWidth }}
            aria-hidden
          >
            {index + 1}
          </span>
          <code
            className="hljs block min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: html || ' ' }}
          />
        </div>
      ))}
    </div>
  );
}

/** Split highlight.js spans at newlines while keeping multiline token colors intact. */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const openSpans: string[] = [];
  let current = '';
  for (const part of html.split(/(<span\b[^>]*>|<\/span>|\n)/g)) {
    if (part === '\n') {
      lines.push(current + '</span>'.repeat(openSpans.length));
      current = openSpans.join('');
    } else if (part.startsWith('<span')) {
      openSpans.push(part);
      current += part;
    } else if (part === '</span>') {
      openSpans.pop();
      current += part;
    } else {
      current += part;
    }
  }
  lines.push(current);
  return lines;
}
