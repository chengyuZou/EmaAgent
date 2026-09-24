// SkillTool 的桌面展示:技能名与绝对路径参数行,以及元信息和指令预览结果卡。
// 指令全文在 data 槽的 TOutput 里;指令本体是 Markdown, 走共享 Markdown 渲染器。
import type { JSX } from 'react';
import { Markdown } from '@ema-agent/ui';
import type { SkillToolResult } from './SkillTool.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asSkillToolResult(data: unknown): SkillToolResult | null {
  if (!isRecord(data)) return null;
  if (typeof data['name'] !== 'string' || typeof data['path'] !== 'string' || typeof data['instructions'] !== 'string') return null;
  return data as unknown as SkillToolResult;
}

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

  return (
    <div className="flex flex-col gap-1 pr-6">
      <span className="text-[11px] text-[var(--ema-text-tertiary)]">
        已加载技能 {result.name}{result.version ? ` · v${result.version}` : ''}
      </span>
      <div className="max-h-40 overflow-auto rounded-md border border-[var(--ema-border)] px-2 py-1 text-[11px]">
        <Markdown source={result.instructions} />
      </div>
    </div>
  );
}
