// 在审阅槽中按文件展示真实工具 Diff；默认范围是上一轮，可切换到全部会话。
import { useEffect, useState, type JSX } from 'react';
import { Button } from '@ema-agent/ui';
import { useLatestTurnDiffs, useSessionDiffs, type SessionDiff } from './reviewDiffs.js';

type ReviewScope = 'latest' | 'all';

export function ReviewPanel({ sessionId }: { sessionId: string | null }): JSX.Element {
  const allDiffs = useSessionDiffs(sessionId);
  const latestDiffs = useLatestTurnDiffs(sessionId);
  const [scope, setScope] = useState<ReviewScope>('latest');
  const [activeCallId, setActiveCallId] = useState<string | null>(null);

  // §5：点击"改动"进入时默认定位到当前 Turn 的变更。
  const diffs = scope === 'latest' ? latestDiffs : allDiffs;

  useEffect(() => {
    if (!diffs.some((diff) => diff.callId === activeCallId)) {
      setActiveCallId(diffs[0]?.callId ?? null);
    }
  }, [activeCallId, diffs]);

  if (allDiffs.length === 0) {
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
        {/* 范围选择：只列有真实数据来源的项（上一轮/全部会话）。 */}
        <div className="flex items-center gap-0.5 rounded-md p-0.5 bg-[var(--ema-surface-2)]">
          {(['latest', 'all'] as const).map((s) => (
            <Button
              key={s}
              variant="ghost"
              size="sm"
              className={`px-2 py-0.5 text-[11px] rounded ${
                scope === s
                  ? 'bg-[var(--ema-primary-muted)] text-[var(--ema-primary)]'
                  : 'text-[var(--ema-text-tertiary)]'
              }`}
              onClick={() => setScope(s)}
            >
              {s === 'latest' ? '上一轮' : '全部会话'}
            </Button>
          ))}
        </div>
        <span className="text-[var(--ema-text-secondary)]">{diffs.length} 个变更</span>
        <span className="text-[var(--ema-success-text)]">+{additions}</span>
        <span className="text-[var(--ema-danger-text)]">-{deletions}</span>
      </div>

      {diffs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-[var(--ema-text-tertiary)]">
          <span>上一轮还没有文件变更</span>
          <Button variant="ghost" size="sm" onClick={() => setScope('all')}>
            查看全部会话（{allDiffs.length}）
          </Button>
        </div>
      ) : (
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
      )}
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
