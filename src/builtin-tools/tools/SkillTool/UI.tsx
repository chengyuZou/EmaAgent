// SkillTool 的桌面展示:技能名与绝对路径参数行,以及元信息和指令预览结果卡。
// 指令全文在 data 槽的 TOutput 里;预览有界,全文可滚动查看。
import type { JSX } from 'react';
import { Badge } from '@ema-agent/ui';
import type { SkillToolResult } from './SkillTool.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asSkillToolResult(data: unknown): SkillToolResult | null {
  if (!isRecord(data)) return null;
  if (typeof data['name'] !== 'string' || typeof data['path'] !== 'string' || typeof data['instructions'] !== 'string') return null;
  return data as unknown as SkillToolResult;
}

/** 指令预览行数;全文在卡里可滚动,不需要展开态。 */
const INSTRUCTIONS_PREVIEW_LINES = 6;

export function SkillArgsView({ args }: { args: unknown }): JSX.Element | null {
  if (!isRecord(args) || typeof args['name'] !== 'string' || typeof args['path'] !== 'string') return null;
  return (
    <span className="font-mono text-xs text-[var(--ema-text-secondary)]">
      {args['name']} · {args['path']}
    </span>
  );
}

export function SkillResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asSkillToolResult(data);
  if (!result) return null;

  const lines = result.instructions.split('\n');
  const preview = lines.slice(0, INSTRUCTIONS_PREVIEW_LINES);
  const omitted = lines.length - preview.length;

  return (
    <div className="flex flex-col gap-1 pr-6">
      <span className="flex items-center gap-2 text-[11px] text-[var(--ema-text-tertiary)]">
        <span>已加载技能 {result.name} · v{result.version}</span>
        {result.suggestedTools.length > 0 && (
          <Badge variant="primary">作者建议 {result.suggestedTools.length} 个工具</Badge>
        )}
      </span>
      <div className="max-h-40 overflow-auto rounded-md border border-[var(--ema-border)] px-2 py-1 text-[11px] leading-relaxed">
        <pre className="whitespace-pre-wrap break-all bg-transparent m-0 p-0 text-[var(--ema-text-secondary)] font-mono">
          {preview.join('\n')}
        </pre>
        {omitted > 0 && (
          <div className="text-center text-[10px] text-[var(--ema-text-tertiary)]">
            ··· 其余 {omitted} 行 ···
          </div>
        )}
      </div>
    </div>
  );
}
