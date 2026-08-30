// FileWriteTool 的桌面展示: created 给内容预览, updated 复用结构化补丁卡。
import type { JSX } from 'react';
import type { FileWriteResult } from './FileWriteTool.js';
import { StructuredPatchCard } from '../FileEditTool/UI.js';
import type { PatchHunk } from '../FileEditTool/patch.js';

/** 新建文件预览的最大行数; 超出截断并标注。 */
const CREATED_PREVIEW_LINES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  ) {
    return data as unknown as FileWriteResult;
  }
  return null;
}

// ── 参数视图: 路径 + 写入体积 ─────────────────────────────────────────────────

export function FileWriteArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['file_path'] !== 'string') return null;
  const content = typeof args['content'] === 'string' ? args['content'] : null;
  const sizeKb = content !== null ? (new TextEncoder().encode(content).length / 1024).toFixed(1) : null;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">path:</span>
      <span className="break-all font-mono text-[var(--ema-text-secondary)]" title={args['file_path']}>
        {args['file_path']}
        {sizeKb !== null && (
          <span className="text-[var(--ema-text-tertiary)]">{` · 写入 ${sizeKb} KB`}</span>
        )}
      </span>
    </div>
  );
}

// ── 结果视图 ──────────────────────────────────────────────────────────────────

export function FileWriteResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asFileWriteResult(data);
  if (!result) return null;

  if (result.type === 'updated') {
    const patch: readonly PatchHunk[] = result.structuredPatch;
    const additions = patch.reduce((s, h) => s + h.lines.filter((l) => l.startsWith('+')).length, 0);
    const deletions = patch.reduce((s, h) => s + h.lines.filter((l) => l.startsWith('-')).length, 0);
    return (
      <div className="flex flex-col gap-1 pr-6">
        <div className="flex items-center gap-2 text-[11px] leading-relaxed">
          <span className="text-[var(--ema-text-secondary)]">已覆盖写入</span>
          <span className="text-[var(--ema-success-text)]">+{additions}</span>
          <span className="text-[var(--ema-danger-text)]">-{deletions}</span>
        </div>
        <StructuredPatchCard hunks={patch} />
      </div>
    );
  }

  // created: 内容预览(前 N 行), 全文在结果区可滚。
  const lines = result.content.split('\n');
  const preview = lines.slice(0, CREATED_PREVIEW_LINES);
  const omitted = lines.length - preview.length;
  return (
    <div className="flex flex-col gap-1 pr-6">
      <span className="text-[11px] text-[var(--ema-text-secondary)]">
        新建文件 · {lines.length.toLocaleString()} 行 · {(result.bytesWritten / 1024).toFixed(1)} KB
      </span>
      <div className="max-h-48 overflow-auto rounded-md border border-[var(--ema-border)] px-2 py-1 font-mono text-[11px] leading-relaxed">
        {preview.map((line, index) => (
          <div key={index} className="flex text-[var(--ema-text-tertiary)]">
            <span className="w-9 shrink-0 select-none text-right opacity-60">{index + 1}</span>
            <span className="min-w-0 flex-1 pl-2 whitespace-pre-wrap break-all text-[var(--ema-text-secondary)]">
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
