// GlobTool 的桌面展示: 参数(pattern+path)与结果(文件列表+截断徽标)。
// 只消费本 Tool 的类型化 data; 类型守卫失败一律返回 null, 由前端回落通用渲染。
import type { JSX } from 'react';
import { Badge } from '@ema-agent/ui';
import type { GlobResult } from './GlobTool.js';

// ── 类型守卫(消费 unknown data 的唯一入口) ────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asGlobResult(data: unknown): GlobResult | null {
  if (!isRecord(data) || !Array.isArray(data['files'])) return null;
  if (!data['files'].every((f) => typeof f === 'string')) return null;
  return data as unknown as GlobResult;
}

// ── 参数视图: pattern + 可选 path ──────────────────────────────────────────────

export function GlobArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['pattern'] !== 'string') return null;
  const path = typeof args['path'] === 'string' ? args['path'] : undefined;
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-relaxed">
      <span className="shrink-0 text-[var(--ema-text-tertiary)]">pattern:</span>
      <span className="break-all font-mono text-[var(--ema-text-secondary)]">
        {args['pattern']}
        {path && <span className="text-[var(--ema-text-tertiary)]">{` · ${path}`}</span>}
      </span>
    </div>
  );
}

// ── 结果视图: 数量 + 文件列表 + 截断徽标 ───────────────────────────────────────

export function GlobResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asGlobResult(data);
  if (!result) return null;

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
