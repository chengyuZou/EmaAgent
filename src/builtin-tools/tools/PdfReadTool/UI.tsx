// PdfReadTool 的桌面展示: 参数行(路径 + 页码范围)与结果卡(页数/字符数 + warnings + 内容预览)。
// 只消费本 Tool 的类型化 data; 类型守卫失败返回 null, 由前端回落通用渲染。
import type { JSX } from 'react';
import { Badge } from '@ema-agent/ui';
import type { PdfReadResult } from './PdfReadTool.js';

const PREVIEW_CHARS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPdfReadResult(data: unknown): PdfReadResult | null {
  if (!isRecord(data) || typeof data['filePath'] !== 'string' || typeof data['content'] !== 'string') {
    return null;
  }
  if (typeof data['startPage'] !== 'number' || typeof data['endPage'] !== 'number') return null;
  if (typeof data['totalPages'] !== 'number' || !Array.isArray(data['warnings'])) return null;
  return data as unknown as PdfReadResult;
}

export function PdfReadArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['file_path'] !== 'string') return null;
  const startPage = typeof args['start_page'] === 'number' ? args['start_page'] : undefined;
  const pageCount = typeof args['page_count'] === 'number' ? args['page_count'] : undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed">
      <span className="break-all font-mono text-[var(--ema-text-secondary)]">
        {args['file_path']}
      </span>
      {(startPage !== undefined || pageCount !== undefined) && (
        <span className="text-[var(--ema-text-tertiary)]">
          第 {startPage ?? 1} 页起{pageCount !== undefined ? ` · ${pageCount} 页` : ''}
        </span>
      )}
    </div>
  );
}

export function PdfReadResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asPdfReadResult(data);
  if (!result) return null;

  const preview = result.content.slice(0, PREVIEW_CHARS);
  const omitted = result.content.length - preview.length;
  return (
    <div className="flex flex-col gap-1 text-[11px] leading-relaxed">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[var(--ema-text-secondary)]">
          第 {result.startPage}–{result.endPage} 页 · 共 {result.totalPages} 页
        </span>
        {result.nextPage !== undefined && (
          <Badge variant="warn">可继续读取第 {result.nextPage} 页</Badge>
        )}
        {result.warnings.length > 0 && (
          <Badge variant="danger">读取不完整 {result.warnings.length} 处</Badge>
        )}
      </div>
      <div className="max-h-40 overflow-auto rounded-md border border-[var(--ema-border)] px-2 py-1">
        <pre className="m-0 whitespace-pre-wrap break-all bg-transparent p-0 font-mono text-[var(--ema-text-secondary)]">
          {preview}
          {omitted > 0 && `\n··· 其余 ${omitted.toLocaleString()} 字符 ···`}
        </pre>
      </div>
    </div>
  );
}
