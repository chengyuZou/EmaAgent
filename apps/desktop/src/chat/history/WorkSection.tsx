// Codex 式工作区:一行"已处理 X · 动词摘要 · N 个错误"折叠整段工作,流式直播当前动作。
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { AssistantSlice } from '../../stores/conversation-store.js';
import {
  formatWorkDuration,
  liveAction,
  liveActionLabel,
  tallySummary,
  tallyTools,
} from './workGroups.js';

export interface WorkSectionProps {
  slices: readonly AssistantSlice[];
  streaming: boolean;
  /** 完成的 turn 的持久耗时;流式期间忽略,用 createdAt 现场计。 */
  durationMs?: number;
  createdAt: number;
  children: ReactNode;
}

export function WorkSection({
  slices, streaming, durationMs, createdAt, children,
}: WorkSectionProps): JSX.Element {
  const [open, setOpen] = useState(streaming);
  const [elapsedMs, setElapsedMs] = useState(0);

  // 终态默认收起;展开/收起都走 ema-collapsible 双向动画。
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);

  useEffect(() => {
    if (!streaming) return undefined;
    const tick = (): void => setElapsedMs(Date.now() - createdAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [streaming, createdAt]);

  const tally = tallyTools(slices);
  const parts = tallySummary(slices, tally);
  const action = liveAction(slices, streaming);

  return (
    <div className="flex flex-col">
      <button
        className="flex items-center gap-1.5 py-0.5 text-left text-xs select-none text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-secondary)] transition-colors"
        onClick={() => setOpen((value) => !value)}
      >
        {streaming && (
          <span className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0 bg-[var(--ema-primary)]" aria-hidden />
        )}
        <span className="tabular-nums">
          已处理 {formatWorkDuration(streaming ? elapsedMs : durationMs ?? 0)}
        </span>
        {parts.length > 0 && <span>· {parts.join(' · ')}</span>}
        {tally.errors > 0 && (
          <span className="text-[var(--ema-danger-text)]">· {tally.errors} 个错误</span>
        )}
        <span
          className="i-lucide:chevron-down ml-auto text-[10px] transition-transform duration-[var(--ema-duration-base)]"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          aria-hidden
        />
      </button>

      <div
        className="ema-collapsible"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="flex flex-col gap-1.5 pt-1">
          {children}
          {action && (
            <div className="flex items-center gap-1.5 py-0.5 text-xs text-[var(--ema-text-tertiary)]">
              {action.kind === 'waiting' ? (
                <span>· {liveActionLabel(action)}</span>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0 bg-[var(--ema-primary)]" aria-hidden />
                  <span className="truncate">{liveActionLabel(action)}</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
