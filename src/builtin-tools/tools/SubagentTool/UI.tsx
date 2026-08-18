// SubagentTool 的桌面展示: 完成结果摘要与后台引用卡。
import type { JSX } from 'react';
import { Badge } from '@ema-agent/ui';
import type { SubagentResult } from './SubagentTool.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSubagentResult(data: unknown): SubagentResult | null {
  if (!isRecord(data) || typeof data['agentRunId'] !== 'string') return null;
  if (data['kind'] === 'completed' && typeof data['output'] === 'string') {
    return data as unknown as SubagentResult;
  }
  if (data['kind'] === 'background') {
    return data as unknown as SubagentResult;
  }
  return null;
}

/** 完成输出的预览行数; 完整报告在 AgentRun 面板可查。 */
const OUTPUT_PREVIEW_LINES = 6;

export function SubagentResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asSubagentResult(data);
  if (!result) return null;

  if (result.kind === 'background') {
    return (
      <div className="flex items-center gap-2 text-[11px] leading-relaxed pr-6">
        <span className="text-[var(--ema-text-secondary)]">子 Agent 后台运行中</span>
        <Badge variant={result.via === 'auto' ? 'warn' : 'primary'}>
          {result.via === 'auto' ? '超时自动转后台' : '后台'}
        </Badge>
        <span className="font-mono text-[var(--ema-text-tertiary)]">{result.agentRunId.slice(0, 8)}…</span>
      </div>
    );
  }

  const lines = result.output.split('\n');
  const preview = lines.slice(0, OUTPUT_PREVIEW_LINES);
  const omitted = lines.length - preview.length;
  return (
    <div className="flex flex-col gap-1 pr-6">
      <span className="text-[11px] text-[var(--ema-text-tertiary)]">
        子 Agent 完成 · 输出 {result.output.length.toLocaleString()} 字符
        {` · tokens ${result.usage.inputTokens.toLocaleString()}/${result.usage.outputTokens.toLocaleString()}`}
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
