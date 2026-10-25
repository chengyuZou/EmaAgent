import { useMemo, type JSX } from 'react';
import type { FileWriteResult } from './FileWriteTool.js';
import { patchToUnifiedText } from '../FileEditTool/patch.js';
import { FilePatchView } from '../shared/filePatchView.js';
import { Tooltip, CodeViewer, languageForPath } from '@ema-agent/ui';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function FileWriteResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asFileWriteResult(data);
  if (!result) return null;
  if (result.type === 'updated') {
    return (
      <div className="ema-file-change-content flex min-w-0 flex-col">
        <div className="ema-tool-result-details ema-file-change-summary flex items-center gap-2 text-[11px] leading-relaxed">
          <span className="text-[var(--ema-text-secondary)]">已覆盖写入</span>
          <span className="text-[var(--ema-success-text)]">+{result.additions}</span>
          <span className="text-[var(--ema-danger-text)]">-{result.deletions}</span>
        </div>
        <FilePatchView filePath={result.filePath} hunks={result.structuredPatch} />
      </div>
    );
  }

  return <CreatedFileContent content={result.content} filePath={result.filePath} />;
}

function CreatedFileContent({ content, filePath }: {
  readonly content: string;
  readonly filePath: string;
}): JSX.Element {
  const lineNumbers = useMemo(() => (
    content ? content.split('\n').map((_line, index) => String(index + 1)) : []
  ), [content]);

  return (
    <div className="ema-file-change-content ema-file-code ema-material-code">
      <CodeViewer
        source={content}
        language={languageForPath(filePath) ?? 'text'}
        lineNumbers={lineNumbers}
        embedded
        wrapLines={false}
      />
    </div>
  );
}

/** 行头摘要:写入路径. */
export function fileWriteTitle(args: unknown): string | null {
  return isRecord(args) && typeof args['file_path'] === 'string' ? args['file_path'] : null;
}

export function fileWriteResultSummary(data: unknown): string | null {
  const result = asFileWriteResult(data);
  if (result?.type !== 'created') return null;
  return `新建文件 · ${result.additions.toLocaleString()} 行 · ${(result.bytesWritten / 1024).toFixed(1)} KB`;
}

/** 类型守卫: 失败结果与旧消息不满足形状时返回 null, 前端回落通用渲染. */
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

// 参数视图: 路径 + 写入体积

export function FileWriteArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['file_path'] !== 'string') return null;
  const content = typeof args['content'] === 'string' ? args['content'] : null;
  const sizeKb = content !== null ? (new TextEncoder().encode(content).length / 1024).toFixed(1) : null;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">path:</span>
      <Tooltip content={args['file_path']} variant="card">
        <span className="min-w-0 font-mono text-[var(--ema-text-secondary)]">
          {args['file_path']}
          {sizeKb !== null && (
            <span className="text-[var(--ema-text-tertiary)]">{` · 写入 ${sizeKb} KB`}</span>
          )}
        </span>
      </Tooltip>
    </div>
  );
}
