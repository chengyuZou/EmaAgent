// GrepTool 的桌面展示: 参数(pattern+path+模式)与三态结果(文件列表/计数/匹配行)。
// 只消费本 Tool 的类型化 data; 类型守卫失败一律返回 null, 由前端回落通用渲染。
import type { JSX } from 'react';
import { Badge } from '@ema-agent/ui';
import type { GrepResult } from './GrepTool.js';

// ── 类型守卫(消费 unknown data 的唯一入口) ────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 行头摘要：pattern，限定目录时带 path。 */
export function grepTitle(args: unknown): string | null {
  if (!isRecord(args) || typeof args['pattern'] !== 'string') return null;
  const path = typeof args['path'] === 'string' ? args['path'] : '';
  return path ? `${args['pattern']} in ${path}` : args['pattern'];
}

function asGrepResult(data: unknown): GrepResult | null {
  if (!isRecord(data)) return null;
  switch (data['type']) {
    case 'files_with_matches':
      return Array.isArray(data['files']) && data['files'].every((f) => typeof f === 'string')
        ? (data as unknown as GrepResult)
        : null;
    case 'count':
      return Array.isArray(data['entries']) && typeof data['totalMatches'] === 'number'
        ? (data as unknown as GrepResult)
        : null;
    case 'content':
      return typeof data['output'] === 'string'
        ? (data as unknown as GrepResult)
        : null;
    default:
      return null;
  }
}

// ── 参数视图: pattern + 可选 path/模式 ─────────────────────────────────────────

export function GrepArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['pattern'] !== 'string') return null;
  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  const mode = typeof args['output_mode'] === 'string' ? args['output_mode'] : undefined;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">pattern:</span>
      <span className="break-all font-mono text-[var(--ema-text-secondary)]">
        {args['pattern']}
        {path && <span className="text-[var(--ema-text-tertiary)]">{` · ${path}`}</span>}
        {mode && mode !== 'files_with_matches' && (
          <span className="text-[var(--ema-text-tertiary)]">{` · ${mode}`}</span>
        )}
      </span>
    </div>
  );
}

// ── 结果视图: 三态语义 ────────────────────────────────────────────────────────

export function GrepResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asGrepResult(data);
  if (!result) return null;

  switch (result.type) {
    case 'files_with_matches': {
      if (result.files.length === 0) {
        return <span className="text-[11px] text-[var(--ema-text-tertiary)]">未找到匹配文件</span>;
      }
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[11px] leading-relaxed">
            <span className="text-[var(--ema-text-secondary)]">
              找到 <span className="font-medium">{result.files.length.toLocaleString()}</span> 个文件
            </span>
            {result.truncated && <Badge variant="warn">已截断</Badge>}
          </div>
          <div className="flex flex-col gap-0.5">
            {result.files.map((file) => (
              <span
                key={file}
                className="break-all font-mono text-[11px] leading-relaxed text-[var(--ema-text-secondary)]"
              >
                {file}
              </span>
            ))}
          </div>
        </div>
      );
    }

    case 'count':
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[11px] leading-relaxed">
            <span className="text-[var(--ema-text-secondary)]">
              <span className="font-medium">{result.totalMatches.toLocaleString()}</span> 处匹配
              <span className="text-[var(--ema-text-tertiary)]">
                {' '}/ {result.fileCount.toLocaleString()} 个文件
              </span>
            </span>
            {result.truncated && <Badge variant="warn">已截断</Badge>}
          </div>
          <div className="flex flex-col gap-0.5">
            {result.entries.map((entry) => (
              <span
                key={entry}
                className="break-all font-mono text-[11px] leading-relaxed text-[var(--ema-text-secondary)]"
              >
                {entry}
              </span>
            ))}
          </div>
        </div>
      );

    case 'content': {
      if (result.output === '') {
        return <span className="text-[11px] text-[var(--ema-text-tertiary)]">未找到匹配</span>;
      }
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[11px] leading-relaxed">
            <span className="text-[var(--ema-text-secondary)]">
              <span className="font-medium">{result.numLines.toLocaleString()}</span> 行
            </span>
            {result.truncated && <Badge variant="warn">已截断</Badge>}
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[var(--ema-text-secondary)]">
            {result.output}
          </pre>
        </div>
      );
    }
  }
}
