// FileEditTool 的参数与结果展示; 官方 Diff 组件消费 Tool 保存的补丁.
import type { JSX } from 'react';
import type { StructuredPatchHunk } from 'diff';
import { Badge } from '@ema-agent/ui';
import type { FileEditResult } from './FileEditTool.js';
import { patchToUnifiedText } from './patch.js';
import { FilePatchView } from '../shared/filePatchView.js';

// ── 类型守卫(消费 unknown data 的唯一入口) ────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPatchHunk(value: unknown): value is StructuredPatchHunk {
  return isRecord(value)
    && typeof value['oldStart'] === 'number'
    && typeof value['newStart'] === 'number'
    && Array.isArray(value['lines']);
}

export function FileEditResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asFileEditResult(data);
  if (!result) return null;
  return (
    <div className="ema-file-change-content flex min-w-0 flex-col gap-1">
      <div className="ema-file-change-summary flex items-center gap-2 text-[11px] leading-relaxed">
        <span className="text-[var(--ema-text-secondary)]">
          已编辑 · {result.replacements} 处替换
        </span>
        <span className="text-[var(--ema-success-text)]">+{result.additions}</span>
        <span className="text-[var(--ema-danger-text)]">-{result.deletions}</span>
        {result.replaceAll && <Badge variant="primary">replace_all</Badge>}
      </div>
      <FilePatchView filePath={result.filePath} hunks={result.structuredPatch} />
    </div>
  );
}

/** 失败结果(字符串等)与旧消息都没有这个形状,返回 null 让前端回落通用渲染。 */
export function asFileEditResult(data: unknown): FileEditResult | null {
  if (!isRecord(data)) return null;
  if (
    typeof data['filePath'] === 'string'
    && typeof data['oldString'] === 'string'
    && typeof data['newString'] === 'string'
    && Array.isArray(data['structuredPatch'])
    && data['structuredPatch'].every(isPatchHunk)
    && typeof data['additions'] === 'number'
    && typeof data['deletions'] === 'number'
    && typeof data['replacements'] === 'number'
  ) {
    return data as unknown as FileEditResult;
  }
  return null;
}

/** 行头摘要：编辑目标路径。 */
export function fileEditTitle(args: unknown): string | null {
  return isRecord(args) && typeof args['file_path'] === 'string' ? args['file_path'] : null;
}

/** 复制文本：权威结构化 diff 的 unified 文本；结果未落地时由前端回落默认复制。 */
export function fileEditCopyText(args: unknown, data: unknown): string | null {
  const result = asFileEditResult(data);
  return result ? patchToUnifiedText(result.structuredPatch) : null;
}

// ── 参数视图: 只给路径; old/new 的正文由结果区 diff 表达,不重复展示 ────────────

export function FileEditArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['file_path'] !== 'string') return null;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">path:</span>
      <span className="min-w-0 font-mono text-[var(--ema-text-secondary)]" title={args['file_path']}>
        {args['file_path']}
      </span>
    </div>
  );
}
