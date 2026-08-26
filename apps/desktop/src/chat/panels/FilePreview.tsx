/**
 * FilePreview - in-app 文件预览(像 Codex/Claude)。
 *
 * 点 FilesPanel 文件 -> 调 workspaceApi.readFile -> 按类型渲染:
 *   - md/mdx  -> Markdown 组件
 *   - 图片    -> <img src=data:mime;base64>
 *   - 文本    -> <pre> 纯文本(代码无高亮,Shiki 禁用)
 *   - 过大    -> 提示
 *   - 二进制  -> 提示
 * 顶部回退按钮(IconButton i-lucide:arrow-left)+ 文件名 + 大小。
 * 入场 ema-fade-in(style.css)。ScrollArea 包裹(@ema-agent/ui)。
 */
import { useEffect, useState, type JSX } from 'react';
import { IconButton, ScrollArea, Spinner } from '@ema-agent/ui';
import hljs from 'highlight.js';
import { Markdown } from '../../markdown/renderer.js';
import { filesApi, type FileContent } from '../../api/workspaces.js';

/** 扩展名 -> highlight.js 语言名(常见映射,未知走自动检测) */
const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  json: 'json', jsonl: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', html: 'xml', xml: 'xml', svg: 'xml',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  graphql: 'graphql', gql: 'graphql',
};

/** 高亮代码:按语言指定(准),未知扩展名 fallback 自动检测,都失败回纯文本 */
function highlightCode(code: string, ext: string): string {
  const lang = LANG_MAP[ext];
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
  } catch { /* fall through to auto */ }
  try {
    return hljs.highlightAuto(code).value;
  } catch {
    return code;
  }
}

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
    <div className="flex flex-col h-full ema-fade-in">
      {/* 顶栏:回退 + 文件名 + 大小 */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b shrink-0 border-[var(--ema-border)]">
        <IconButton
          size="sm"
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
      <ScrollArea orientation="both" className="flex-1" viewportClassName="p-3">
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
  // 代码/文本:highlight.js 直接高亮(按 ext 指定语言,未知自动检测),不包 Markdown
  const html = highlightCode(content.content, ext);
  return (
    <pre className="ema-font-mono text-xs whitespace-pre">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}