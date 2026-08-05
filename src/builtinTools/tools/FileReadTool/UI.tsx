// FileReadTool 的桌面展示: 参数(路径+分页范围)与三态结果(文本/去重/图片)。
// 只消费本 Tool 的类型化 data; 类型守卫失败一律返回 null, 由前端回落通用渲染。
import type { JSX } from 'react';
import { Badge } from '@ema-agent/ui';
import type { FileReadResult } from './FileReadTool.js';

// ── 类型守卫(消费 unknown data 的唯一入口) ────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

    case 'file_content': {
      const readLines = result.content === '' ? 0 : result.content.split('\n').length;
      return (
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
        </div>
      );
    }
  }
}
