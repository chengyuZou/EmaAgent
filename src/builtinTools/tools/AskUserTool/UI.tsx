// AskUserTool 的桌面展示: 结果区把 answers 渲染为 Q→A 对。
import type { JSX } from 'react';
import type { AskUserResult } from './AskUserTool.js';

function asAskUserResult(data: unknown): AskUserResult | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const answers = (data as Record<string, unknown>)['answers'];
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return null;
  if (!Object.values(answers).every((v) => typeof v === 'string')) return null;
  return data as unknown as AskUserResult;
}

export function AskUserResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asAskUserResult(data);
  if (!result) return null;
  const entries = Object.entries(result.answers);
  if (entries.length === 0) {
    return <span className="text-[11px] text-[var(--ema-text-tertiary)]">用户未作答</span>;
  }
  return (
    <div className="flex flex-col gap-1 pr-6">
      {entries.map(([question, answer]) => (
        <div key={question} className="text-[11px] leading-relaxed">
          <div className="text-[var(--ema-text-tertiary)]">{question}</div>
          <div className="pl-3 text-[var(--ema-text-secondary)]">
            {answer || <span className="text-[var(--ema-text-tertiary)]">（未作答）</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
