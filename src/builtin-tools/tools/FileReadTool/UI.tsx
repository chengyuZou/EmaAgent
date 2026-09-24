// FileReadTool 的桌面展示: 参数(路径+分页范围)与结果卡.
// 结果按类型分流: 图片直接渲染(base64 已有), 文本内容按扩展名走
// Markdown 渲染 / hljs 高亮源码 / HTML 沙箱预览三态.
// 只消费本 Tool 的类型化 data; 类型守卫失败一律返回 null, 由前端回落通用渲染。
import { useMemo, useState, type JSX } from 'react';
import { Badge, Button, Markdown, highlightFile, languageForPath } from '@ema-agent/ui';
import type { FileReadResult } from './FileReadTool.js';

// ── 类型守卫(消费 unknown data 的唯一入口) ────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 行头摘要：读取路径。 */
export function fileReadTitle(args: unknown): string | null {
  return isRecord(args) && typeof args['file_path'] === 'string' ? args['file_path'] : null;
}

function asFileReadResult(data: unknown): FileReadResult | null {
  if (!isRecord(data) || typeof data['filePath'] !== 'string') return null;
  switch (data['type']) {
    case 'file_content':
      return typeof data['content'] === 'string' && typeof data['totalLines'] === 'number'
        ? (data as unknown as FileReadResult)
        : null;
    case 'file_unchanged':
      return typeof data['totalLines'] === 'number' ? (data as unknown as FileReadResult) : null;
    case 'image_content':
      return typeof data['base64'] === 'string' && typeof data['mediaType'] === 'string'
        ? (data as unknown as FileReadResult)
        : null;
    case 'notebook_content':
      return typeof data['totalCells'] === 'number' && Array.isArray(data['cells'])
        ? (data as unknown as FileReadResult)
        : null;
    default:
      return null;
  }
}

// ── 参数视图: 路径 + 分页范围 ─────────────────────────────────────────────────

export function FileReadArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['file_path'] !== 'string') return null;
  const offset = typeof args['offset'] === 'number' ? args['offset'] : undefined;
  const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;

  let range: string | null = null;
  if (offset !== undefined || limit !== undefined) {
    const start = offset ?? 1;
    range = limit !== undefined ? `第 ${start}–${start + limit - 1} 行` : `从第 ${start} 行起`;
  }

  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">path:</span>
      <span className="break-all font-mono text-[var(--ema-text-secondary)]">
        {args['file_path']}
        {range && <span className="text-[var(--ema-text-tertiary)]">{` · ${range}`}</span>}
      </span>
    </div>
  );
}

// ── 结果视图: 三态语义 ────────────────────────────────────────────────────────

export function FileReadResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asFileReadResult(data);
  if (!result) return null;

  switch (result.type) {
    case 'file_unchanged':
      return (
        <span className="text-[11px] text-[var(--ema-text-tertiary)]">
          与上次读取一致 · 共 {result.totalLines.toLocaleString()} 行
        </span>
      );

    case 'image_content':
      return (
        <div className="flex flex-col gap-1.5 pr-6">
          <img
            src={`data:${result.mediaType};base64,${result.base64}`}
            alt={result.filePath}
            className="max-h-48 w-fit rounded-md border border-[var(--ema-border)] object-contain"
          />
          <span className="text-[11px] text-[var(--ema-text-tertiary)]">
            {result.mediaType} · {(result.originalBytes / 1024).toFixed(1)} KB
          </span>
        </div>
      );

    case 'notebook_content': {
      // 摘要 + 每 cell 一行轻量 chrome(类型/语言/字符数/输出数), 不渲染 source 内容。
      if (result.totalCells < 1) {
        return <Badge variant="danger">Notebook 没有 cell</Badge>;
      }
      return (
        <div className="flex flex-col gap-1 pr-6">
          <span className="text-[11px] text-[var(--ema-text-secondary)]">
            读取 <span className="font-medium">{result.totalCells.toLocaleString()}</span> 个 cell
          </span>
          <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
            {result.cells.map((cell, index) => (
              <div key={index} className="flex items-center gap-2 text-[11px] leading-relaxed">
                <Badge variant={cell.cellType === 'code' ? 'neutral' : 'success'}>
                  {cell.cellType === 'code' ? 'code' : 'md'}
                </Badge>
                {cell.cellType === 'code' && (
                  <span className="text-[var(--ema-text-tertiary)]">{cell.language}</span>
                )}
                <span className="text-[var(--ema-text-tertiary)]">
                  {cell.source.length.toLocaleString()} 字符
                </span>
                {cell.outputs && cell.outputs.length > 0 && (
                  <span className="text-[var(--ema-text-tertiary)]">
                    · {cell.outputs.length} 输出
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    }

    case 'file_content':
      return <FileReadContentCard result={result} />;
  }
}

// ── 文本内容卡: 按扩展名分流渲染 ─────────────────────────────────────────────

type FileContentResult = Extract<FileReadResult, { type: 'file_content' }>;

function FileReadContentCard({ result }: { result: FileContentResult }): JSX.Element {
  const extension = result.filePath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
  const isMarkdown = ['md', 'markdown', 'mdx'].includes(extension);
  const isHtml = ['html', 'htm'].includes(extension);
  const hasLanguage = languageForPath(result.filePath) !== null;
  const [showHtmlPreview, setShowHtmlPreview] = useState(false);

  // 高亮只跑一次, 分页追加的同文件结果是新对象, memo 按内容+路径缓存.
  const highlighted = useMemo(
    () => (!isMarkdown && hasLanguage ? highlightFile(result.content, result.filePath) : null),
    [isMarkdown, hasLanguage, result.content, result.filePath],
  );

  const readLines = result.content === '' ? 0 : result.content.split('\n').length;
  return (
    <div className="flex flex-col gap-1 pr-6">
      <div className="flex items-center gap-2 text-[11px] leading-relaxed">
        <span className="text-[var(--ema-text-secondary)]">
          读取 <span className="font-medium">{readLines.toLocaleString()}</span> 行
          <span className="text-[var(--ema-text-tertiary)]">
            （共 {result.totalLines.toLocaleString()} 行）
          </span>
        </span>
        {result.truncated && (
          <Badge variant="warn">
            已截断{result.nextOffset !== undefined ? ` · 从第 ${result.nextOffset} 行继续` : ''}
          </Badge>
        )}
        {isHtml && (
          <span className="ml-auto flex gap-1">
            <Button variant={showHtmlPreview ? 'ghost' : 'secondary'} size="sm" onClick={() => setShowHtmlPreview(false)}>
              源码
            </Button>
            <Button variant={showHtmlPreview ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowHtmlPreview(true)}>
              预览
            </Button>
          </span>
        )}
      </div>

      {isMarkdown && (
        <div className="max-h-48 overflow-auto rounded-md border border-[var(--ema-border)] px-2 py-1 text-[11px]">
          <Markdown source={result.content} />
        </div>
      )}

      {isHtml && showHtmlPreview && (
        /* sandbox 空属性: 禁脚本禁表单, 只渲染视觉; 本地文件与公网抓取同一边界. */
        <iframe
          sandbox=""
          srcDoc={result.content}
          title="HTML 预览"
          className="h-48 w-full rounded-md border border-[var(--ema-border)] bg-white"
        />
      )}

      {!isMarkdown && (!isHtml || !showHtmlPreview) && (
        <pre className="hljs max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--ema-border)] px-2 py-1 font-mono text-[11px] leading-relaxed text-[var(--ema-text-secondary)]">
          {highlighted !== null
            ? <code dangerouslySetInnerHTML={{ __html: highlighted }} />
            : result.content}
        </pre>
      )}
    </div>
  );
}
