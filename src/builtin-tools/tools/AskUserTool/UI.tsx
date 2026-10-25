import type { JSX } from 'react';
import type { AskUserResult } from './AskUserTool.js';

function asAskUserResult(data: unknown): AskUserResult | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const answers = (data as Record<string, unknown>)['answers'];
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return null;
  if (!Object.values(answers).every((v) => typeof v === 'string')) return null;
  return data as unknown as AskUserResult;
}

export function askUserResultCopyText(data: unknown): string | null {
  const result = asAskUserResult(data);
  return result
    ? Object.entries(result.answers).map(([question, answer]) => `${question}: ${answer}`).join('\n')
    : null;
}

export function AskUserResultView({ data }: { data: unknown }): JSX.Element | null {
  const result = asAskUserResult(data);
  if (!result) return null;
  const entries = Object.entries(result.answers);
  if (entries.length === 0) {
    return <div className="ema-tool-result-details text-[11px] text-[var(--ema-text-tertiary)]">用户未作答</div>;
  }
  return (
    <div className="ema-tool-text-scroll ema-tool-result-details flex flex-col gap-1">
      {entries.map(([question, answer]) => (
        <div key={question} className="text-[11px] leading-relaxed">
          <div className="text-[var(--ema-text-tertiary)]">{question}</div>
          <div className="pl-3 text-[var(--ema-text-secondary)]">
            {answer || <span className="text-[var(--ema-text-tertiary)]">(未作答)</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
