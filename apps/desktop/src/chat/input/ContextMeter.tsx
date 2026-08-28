// 显示当前 Session 下一次根调用预计占用的上下文，并展开本地估算分类。
import { useState, type JSX } from 'react';
import { Popover } from '@ema-agent/ui';
import type { ContextUsage, ContextUsageCategories } from '@ema-agent/context';
import { useContextUsage } from '../state/contextUsage.js';

export interface ContextMeterProps {
  readonly sessionId: string | null;
}

interface CategoryRow {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  readonly color: string;
}

const CATEGORY_COLORS = {
  system: 'var(--ema-primary)',
  tools: 'var(--ema-info)',
  skills: 'var(--ema-warning)',
  memory: 'var(--ema-violet)',
  character: 'var(--ema-danger)',
  messages: 'var(--ema-success)',
} as const;

export function ContextMeter({ sessionId }: ContextMeterProps): JSX.Element {
  const entry = useContextUsage(state => sessionId ? state.bySession[sessionId] : undefined);
  const [toolsOpen, setToolsOpen] = useState(false);
  const inputTokens = entry?.kind === 'llm_call' ? entry.usage.inputTokens : entry?.inputTokens ?? 0;
  const contextWindow = entry?.kind === 'llm_call'
    ? entry.usage.contextWindow
    : entry?.contextWindow ?? 0;
  const ratio = contextWindow > 0 ? Math.min(1, Math.max(0, inputTokens / contextWindow)) : 0;
  const percent = Math.round(ratio * 100);

  return (
    <Popover
      side="top"
      align="end"
      widthClass="w-80"
      trigger={<MeterButton percent={percent} hasUsage={entry !== undefined} />}
    >
      {!entry ? (
        <div className="px-2 py-3 text-sm text-[var(--ema-text-tertiary)]">
          等待当前 Session 的首次模型调用统计。
        </div>
      ) : entry.kind === 'manual_compact' ? (
        <ManualCompactPanel
          inputTokens={entry.inputTokens}
          contextWindow={entry.contextWindow}
          percent={percent}
        />
      ) : (
        <LlmCallPanel
          percent={percent}
          toolsOpen={toolsOpen}
          onToolsOpenChange={setToolsOpen}
          usage={entry.usage}
        />
      )}
    </Popover>
  );
}

function MeterButton({ percent, hasUsage }: { percent: number; hasUsage: boolean }): JSX.Element {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);
  return (
    <button
      type="button"
      className="flex size-7 items-center justify-center rounded-full text-[var(--ema-text-tertiary)] transition-colors hover:bg-[var(--ema-surface-3)] hover:text-[var(--ema-text-primary)] focus-ring"
      aria-label={hasUsage ? `上下文已使用 ${percent}%` : '上下文用量尚未统计'}
      title={hasUsage ? `Context ${percent}%` : '等待 Context 统计'}
    >
      <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden>
        <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
        {hasUsage && (
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="var(--ema-primary)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        )}
      </svg>
    </button>
  );
}

function ManualCompactPanel(input: {
  readonly inputTokens: number;
  readonly contextWindow: number;
  readonly percent: number;
}): JSX.Element {
  return (
    <div className="space-y-3 p-2">
      <UsageHeader
        approximate
        label="压缩后估算"
        inputTokens={input.inputTokens}
        contextWindow={input.contextWindow}
        percent={input.percent}
      />
      <UsageBar percent={input.percent} />
      <p className="text-xs leading-5 text-[var(--ema-text-tertiary)]">
        分类将在下一次根模型调用装配后重新统计。
      </p>
    </div>
  );
}

function LlmCallPanel(input: {
  readonly percent: number;
  readonly toolsOpen: boolean;
  readonly onToolsOpenChange: (open: boolean) => void;
  readonly usage: ContextUsage;
}): JSX.Element {
  const { usage } = input;
  const rows = categoryRows(usage.categories);
  const categoryTotal = rows.reduce((sum, row) => sum + row.tokens, 0);
  const cacheReadRate = usage.cacheReadInputTokens === undefined || usage.inputTokens <= 0
    ? undefined
    : usage.cacheReadInputTokens / usage.inputTokens;

  return (
    <div className="space-y-3 p-2">
      <UsageHeader
        approximate={usage.source === 'estimate'}
        label="上下文已用"
        inputTokens={usage.inputTokens}
        contextWindow={usage.contextWindow}
        percent={input.percent}
      />
      <CategoryBar rows={rows} total={categoryTotal} />
      <div className="space-y-1">
        {rows.map(row => row.key === 'tools' ? (
          <div key={row.key}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-xs hover:bg-[var(--ema-surface-3)]"
              onClick={() => input.onToolsOpenChange(!input.toolsOpen)}
            >
              <CategoryDot color={row.color} />
              <span>Tools</span>
              <span className={`${input.toolsOpen ? 'i-lucide:chevron-up' : 'i-lucide:chevron-down'} text-[10px] text-[var(--ema-text-tertiary)]`} aria-hidden />
              <EstimatedTokens tokens={row.tokens} />
            </button>
            {input.toolsOpen && (
              <div className="ml-5 border-l border-[var(--ema-border)] pl-3 text-[11px] text-[var(--ema-text-tertiary)]">
                <TokenLine label="内置工具" tokens={usage.categories.tools.systemToolTokens} />
                <TokenLine label="MCP 工具" tokens={usage.categories.tools.mcpToolTokens} />
              </div>
            )}
          </div>
        ) : (
          <div key={row.key} className="flex items-center gap-2 px-1 py-1 text-xs">
            <CategoryDot color={row.color} />
            <span>{row.label}</span>
            <EstimatedTokens tokens={row.tokens} />
          </div>
        ))}
      </div>
      {cacheReadRate !== undefined && (
        <div className="flex items-center justify-between border-t border-[var(--ema-border)] pt-2 text-xs text-[var(--ema-text-tertiary)]">
          <span>缓存读取占比</span>
          <span className="font-mono">{Math.round(cacheReadRate * 100)}%</span>
        </div>
      )}
    </div>
  );
}

function UsageHeader(input: {
  readonly approximate: boolean;
  readonly label: string;
  readonly inputTokens: number;
  readonly contextWindow: number;
  readonly percent: number;
}): JSX.Element {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-[var(--ema-text-primary)]">{input.label} {input.percent}%</p>
        <p className="mt-0.5 text-[11px] text-[var(--ema-text-tertiary)]">
          {input.approximate ? '本地估算' : 'Provider 实报'}
        </p>
      </div>
      <span className="font-mono text-xs text-[var(--ema-text-secondary)]">
        {input.approximate ? '~' : ''}{formatTokens(input.inputTokens)} / {formatTokens(input.contextWindow)}
      </span>
    </div>
  );
}

function UsageBar({ percent }: { percent: number }): JSX.Element {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--ema-surface-3)]">
      <div className="h-full rounded-full bg-[var(--ema-primary)]" style={{ width: `${percent}%` }} />
    </div>
  );
}

function CategoryBar({ rows, total }: { rows: readonly CategoryRow[]; total: number }): JSX.Element {
  if (total <= 0) return <UsageBar percent={0} />;
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-[var(--ema-surface-3)]">
      {rows.filter(row => row.tokens > 0).map(row => (
        <span
          key={row.key}
          className="h-full"
          style={{ width: `${(row.tokens / total) * 100}%`, background: row.color }}
        />
      ))}
    </div>
  );
}

function CategoryDot({ color }: { color: string }): JSX.Element {
  return <span className="size-2 rounded-sm" style={{ background: color }} aria-hidden />;
}

function EstimatedTokens({ tokens }: { tokens: number }): JSX.Element {
  return <span className="ml-auto font-mono text-[var(--ema-text-tertiary)]">~{formatTokens(tokens)}</span>;
}

function TokenLine({ label, tokens }: { label: string; tokens: number }): JSX.Element {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span>{label}</span>
      <span className="font-mono">~{formatTokens(tokens)}</span>
    </div>
  );
}

function categoryRows(categories: ContextUsageCategories): CategoryRow[] {
  return [
    { key: 'system', label: '系统提示词', tokens: categories.systemPromptTokens, color: CATEGORY_COLORS.system },
    { key: 'tools', label: 'Tools', tokens: categories.tools.totalTokens, color: CATEGORY_COLORS.tools },
    { key: 'skills', label: 'Skills', tokens: categories.skillTokens, color: CATEGORY_COLORS.skills },
    { key: 'memory', label: 'Memory', tokens: categories.memoryTokens, color: CATEGORY_COLORS.memory },
    { key: 'character', label: '角色 Prompt', tokens: categories.characterPromptTokens, color: CATEGORY_COLORS.character },
    { key: 'messages', label: 'Messages', tokens: categories.messageTokens, color: CATEGORY_COLORS.messages },
  ];
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) {
    const value = tokens / 1_000;
    return `${value < 10 ? value.toFixed(1) : Math.round(value)}K`;
  }
  const value = tokens / 1_000_000;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}M`;
}
