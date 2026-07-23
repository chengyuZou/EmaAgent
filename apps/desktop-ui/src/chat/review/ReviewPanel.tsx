// 在右侧审阅槽中按文件展示当前 Session 的真实工具 Diff。
import { useEffect, useState, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import { useSessionDiffs, type SessionDiff } from './reviewDiffs.js';

export function ReviewPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const diffs = useSessionDiffs(sessionId);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);

  useEffect(() => {
    if (!diffs.some((diff) => diff.callId === activeCallId)) {
      setActiveCallId(diffs[0]?.callId ?? null);
    }
  }, [activeCallId, diffs]);

  if (diffs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
        <span className="i-lucide:file-diff text-2xl opacity-40" aria-hidden />
        当前 Session 还没有文件变更
      </div>
    );
  }

  const additions = diffs.reduce((total, diff) => total + diff.change.additions, 0);
  const deletions = diffs.reduce((total, diff) => total + diff.change.deletions, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--ema-border)] px-3 py-2 text-xs">
        <span className="text-[var(--ema-text-secondary)]">{diffs.length} 个变更</span>
        <span className="text-[var(--ema-success-text)]">+{additions}</span>
        <span className="text-[var(--ema-danger-text)]">-{deletions}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="flex flex-col gap-1.5">
          {diffs.map((diff) => (
            <ReviewDiffCard
              key={diff.callId}
              diff={diff}
              expanded={activeCallId === diff.callId}
              onToggle={() => setActiveCallId((current) => (
                current === diff.callId ? null : diff.callId
              ))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewDiffCard({
  diff,
  expanded,
  onToggle,
}: {
  diff: SessionDiff;
  expanded: boolean;
  onToggle(): void;
}): JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-1)]">
      <Button
        variant="ghost"
        className="flex w-full items-center gap-2 rounded-none px-2.5 py-2 text-left"
        onClick={onToggle}
      >
        <span className="i-lucide:file-code-2 shrink-0 text-sm text-[var(--ema-text-tertiary)]" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--ema-text-secondary)]">
          {diff.change.filePath}
        </span>
        <span className="text-[11px] text-[var(--ema-success-text)]">+{diff.change.additions}</span>
        <span className="text-[11px] text-[var(--ema-danger-text)]">-{diff.change.deletions}</span>
        <span
          className="i-lucide:chevron-down text-xs text-[var(--ema-text-tertiary)] transition-transform duration-[var(--ema-duration-base)]"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden
        />
      </Button>
      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
      >
        <div>
          <pre className="max-h-96 overflow-auto border-t border-[var(--ema-border)] bg-transparent p-2 font-mono text-[11px] leading-relaxed">
            {diff.change.unifiedDiff.split('\n').map((line, index) => (
              <span key={index} className={diffLineClass(line)}>
                {line}{'\n'}
              </span>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'block text-[var(--ema-success-text)]';
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'block text-[var(--ema-danger-text)]';
  }
  if (line.startsWith('@@')) return 'block text-[var(--ema-info-text)]';
  return 'block text-[var(--ema-text-tertiary)]';
}
