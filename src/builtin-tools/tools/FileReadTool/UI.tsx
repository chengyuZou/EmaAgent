import { useMemo, useState, type JSX } from 'react';
import { Badge, Button, CodeViewer, HtmlPreview, languageForPath, Tooltip } from '@ema-agent/ui';
import type { FileReadResult } from './FileReadTool.js';
import { PdfContentView } from './pdfContentView.js';

// 类型守卫(消费 unknown data 的唯一入口)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 行头摘要:读取路径. */
export function fileReadTitle(args: unknown): string | null {
  return isRecord(args) && typeof args['file_path'] === 'string' ? args['file_path'] : null;
}

function asFileReadResult(data: unknown): FileReadResult | null {
  if (!isRecord(data) || typeof data['filePath'] !== 'string') return null;
  switch (data['type']) {
    case 'pdf_content':
      return typeof data['content'] === 'string'
        && typeof data['startPage'] === 'number'
        && typeof data['endPage'] === 'number'
        && typeof data['totalPages'] === 'number'
        && Array.isArray(data['warnings'])
        && data['warnings'].every(warning => isRecord(warning)
          && typeof warning['page'] === 'number'
          && typeof warning['code'] === 'string'
          && typeof warning['message'] === 'string'
          && typeof warning['retryable'] === 'boolean')
        ? (data as unknown as FileReadResult)
        : null;
    case 'file_content':
      return typeof data['content'] === 'string' && typeof data['totalLines'] === 'number'
        ? (data as unknown as FileReadResult)
        : null;
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

export function fileReadResultCopyText(data: unknown): string | null {
  const result = asFileReadResult(data);
  if (!result) return null;
  switch (result.type) {
    case 'pdf_content':
    case 'file_content': return result.content;
    case 'image_content': return result.filePath;
    case 'notebook_content': return `${result.filePath} · ${result.totalCells} 个 cell`;
  }
}

export function fileReadResultSummary(data: unknown): string | null {
  const result = asFileReadResult(data);
  if (result?.type !== 'file_content') return null;
  const readLines = result.content === '' ? 0 : result.content.split('\n').length;
  return `读取 ${readLines.toLocaleString()} 行(共 ${result.totalLines.toLocaleString()} 行)`;
}

// 参数视图: 路径 + 分页范围

export function FileReadArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['file_path'] !== 'string') return null;
  const offset = typeof args['offset'] === 'number' ? args['offset'] : undefined;
  const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;

  const startPage = typeof args['start_page'] === 'number' ? args['start_page'] : undefined;
  const pageCount = typeof args['page_count'] === 'number' ? args['page_count'] : undefined;
  let range: string | null = null;
  if (offset !== undefined || limit !== undefined) {
    const start = offset ?? 1;
    range = limit !== undefined ? `第 ${start}-${start + limit - 1} 行` : `从第 ${start} 行起`;
  }

  if (startPage !== undefined || pageCount !== undefined) {
    const start = startPage ?? 1;
    range = pageCount !== undefined ? `第 ${start}-${start + pageCount - 1} 页` : `从第 ${start} 页起`;
  }

  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">path:</span>
      <span className="min-w-0 font-mono text-[var(--ema-text-secondary)]">
        {args['file_path']}
        {range && <span className="text-[var(--ema-text-tertiary)]">{` · ${range}`}</span>}
      </span>
    </div>
  );
}

// 结果视图: 按文件格式展示

export function FileReadResultView({ data, renderImage, renderMarkdown }: {
  readonly data: unknown;
  readonly renderImage: (image: { readonly src: string; readonly alt: string }) => JSX.Element;
  readonly renderMarkdown: (source: string, filePath: string) => JSX.Element;
}): JSX.Element | null {
  const result = asFileReadResult(data);
  if (!result) return null;

  switch (result.type) {
    case 'pdf_content':
      return <PdfContentView result={result} />;
    case 'image_content':
      return (
        <Tooltip
          content={`${result.mediaType} · ${(result.originalBytes / 1024).toFixed(1)} KB`}
        >
          <span className="inline-flex w-fit max-w-full">
            {renderImage({
              src: `data:${result.mediaType};base64,${result.base64}`,
              alt: result.filePath,
            })}
          </span>
        </Tooltip>
      );

    case 'notebook_content': {
      // 摘要 + 每 cell 一行轻量 chrome(类型/语言/字符数/输出数), 不渲染 source 内容.
      if (result.totalCells < 1) {
        return <Badge variant="danger">Notebook 没有 cell</Badge>;
      }
      return (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--ema-text-secondary)]">
            读取 <span className="font-medium">{result.totalCells.toLocaleString()}</span> 个 cell
          </span>
          <div className="flex flex-col gap-0.5">
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
      return <FileReadContentCard result={result} renderMarkdown={renderMarkdown} />;
  }
}

// 文本内容卡: 按扩展名分流渲染

type FileContentResult = Extract<FileReadResult, { type: 'file_content' }>;

function FileReadContentCard({ result, renderMarkdown }: {
  readonly result: FileContentResult;
  readonly renderMarkdown: (source: string, filePath: string) => JSX.Element;
}): JSX.Element {
  const extension = result.filePath.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
  const isMarkdown = ['md', 'markdown', 'mdx'].includes(extension);
  const isHtml = ['html', 'htm'].includes(extension);
  const [showHtmlPreview, setShowHtmlPreview] = useState(false);

  // 编号单独展示, Markdown 只消费原文; 结果信封与外层复制仍保留模型定位编号.
  const { source, lineNumbers } = useMemo(() => {
    const lineNumbers: string[] = [];
    const source = result.content.replace(/^ *(\d+)\t/gm, (_prefix, number: string) => {
      lineNumbers.push(number);
      return '';
    });
    return { source, lineNumbers };
  }, [result.content]);
  return (
    <div className="ema-tool-result-layout ema-file-read-content flex min-w-0 flex-col">
      {(result.truncated || isHtml) && (
        <div className="ema-tool-result-details ema-file-read-summary flex flex-wrap items-center gap-2 text-[11px] leading-relaxed">
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
      )}

      {isHtml && showHtmlPreview && (
        <HtmlPreview source={source} title="HTML 预览" />
      )}

      {(!isHtml || !showHtmlPreview) && (
        <div className={isMarkdown ? 'ema-tool-result-details min-w-0 text-[12px]' : 'ema-file-read-code ema-material-code'}>
          {isMarkdown
            ? renderMarkdown(source, result.filePath)
            : (
              <CodeViewer
                source={source}
                language={languageForPath(result.filePath) ?? 'text'}
                lineNumbers={lineNumbers}
                embedded
                wrapLines={false}
              />
            )}
        </div>
      )}
    </div>
  );
}
