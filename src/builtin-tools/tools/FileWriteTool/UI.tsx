// FileWriteTool 的参数与结果展示; 覆盖写入和 Edit 共用官方补丁视图.
import type { JSX } from 'react';
import type { FileWriteResult } from './FileWriteTool.js';
import { patchToUnifiedText } from '../FileEditTool/patch.js';
import { FilePatchView } from '../shared/filePatchView.js';

const CREATED_PREVIEW_LINES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function FileWriteResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asFileWriteResult(data);
  if (!result) return null;
  if (result.type === 'updated') {
    return (
      <div className="ema-file-change-content flex min-w-0 flex-col gap-1">
        <div className="ema-file-change-summary flex items-center gap-2 text-[11px] leading-relaxed">
          <span className="text-[var(--ema-text-secondary)]">已覆盖写入</span>
          <span className="text-[var(--ema-success-text)]">+{result.additions}</span>
          <span className="text-[var(--ema-danger-text)]">-{result.deletions}</span>
        </div>
        <FilePatchView filePath={result.filePath} hunks={result.structuredPatch} />
      </div>
    );
  }

  const lines = result.content.length === 0 ? [] : result.content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const preview = lines.slice(0, CREATED_PREVIEW_LINES);
  const omitted = lines.length - preview.length;
  return (
    <div className="ema-file-change-content flex min-w-0 flex-col gap-1">
      <span className="ema-file-change-summary text-[11px] text-[var(--ema-text-secondary)]">
        新建文件 · {result.additions.toLocaleString()} 行 · {(result.bytesWritten / 1024).toFixed(1)} KB
      </span>
      <div className="w-max min-w-full font-mono text-[11px] leading-relaxed">
        {preview.map((line, index) => (
          <div key={index} className="flex text-[var(--ema-text-tertiary)]">
            <span className="w-9 shrink-0 select-none text-right opacity-60">{index + 1}</span>
            <span className="min-w-0 flex-1 pl-2 whitespace-pre text-[var(--ema-text-secondary)]">
              {line}
            </span>
          </div>
        ))}
        {omitted > 0 && (
          <div className="px-2 py-0.5 text-center text-[10px] text-[var(--ema-text-tertiary)]">
            ··· 其余 {omitted} 行 ···
          </div>
        )}
      </div>
    </div>
  );
}

/** 行头摘要：写入路径。 */
export function fileWriteTitle(args: unknown): string | null {
  return isRecord(args) && typeof args['file_path'] === 'string' ? args['file_path'] : null;
}

/** 类型守卫: 失败结果与旧消息不满足形状时返回 null, 前端回落通用渲染。 */
export function asFileWriteResult(data: unknown): FileWriteResult | null {
  if (!isRecord(data)) return null;
  if (
    (data['type'] === 'created' || data['type'] === 'updated')
    && typeof data['filePath'] === 'string'
    && typeof data['bytesWritten'] === 'number'
    && typeof data['content'] === 'string'
    && (data['originalFile'] === null || typeof data['originalFile'] === 'string')
    && Array.isArray(data['structuredPatch'])
    && typeof data['additions'] === 'number'
    && typeof data['deletions'] === 'number'
  ) {
    return data as unknown as FileWriteResult;
  }
  return null;
}

export function fileWriteResultCopyText(data: unknown): string | null {
  const result = asFileWriteResult(data);
  if (!result) return null;
  return result.type === 'updated'
    ? patchToUnifiedText(result.structuredPatch)
    : result.content;
}

// ── 参数视图: 路径 + 写入体积 ─────────────────────────────────────────────────

export function FileWriteArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['file_path'] !== 'string') return null;
  const content = typeof args['content'] === 'string' ? args['content'] : null;
  const sizeKb = content !== null ? (new TextEncoder().encode(content).length / 1024).toFixed(1) : null;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">path:</span>
      <span className="min-w-0 font-mono text-[var(--ema-text-secondary)]" title={args['file_path']}>
        {args['file_path']}
        {sizeKb !== null && (
          <span className="text-[var(--ema-text-tertiary)]">{` · 写入 ${sizeKb} KB`}</span>
        )}
      </span>
    </div>
  );
}
