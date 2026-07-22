import type { CSSProperties, JSX } from 'react';
import { cn } from '../utils/cn.js';

// ── StatCard ─────────────────────────────────────────────────────────────────
//
// Compact statistic card: icon + label + value + optional sub.
// Replaces duplicate StatCard definitions in MemoryTab / StorageTab.
// size="lg" = big number (memory overview), size="md" = compact (storage stats).

export interface StatCardProps {
  label:     string;
  value:     string | number;
  sub?:      string;
  /** UnoCSS icon class, e.g. "i-solar:chat-round-bold-duotone". */
  icon?:     string;
  /** Stagger index for `ema-stagger-in` entrance animation. */
  index?:    number;
  /** `ema-card-decorate--xxx` variant. */
  decorate?: string;
  size?:     'md' | 'lg';
  className?: string;
}

export function StatCard({ label, value, sub, icon, index, decorate, size = 'md', className }: StatCardProps): JSX.Element {
  const isNum = typeof value === 'number';
  return (
    <div
      className={cn(
        'ema-stagger-in ema-glass-weak ema-card-decorate bg-[var(--ema-surface-1)] rounded-xl border-2 border-solid border-[var(--ema-border)]',
        'hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]',
        'px-4 py-3 flex items-start gap-3 shadow-[var(--ema-shadow-1)]',
        decorate,
        className,
      )}
      style={{ '--stagger-i': index } as CSSProperties}
    >
      {icon && <span className={`${icon} text-xl shrink-0 mt-0.5 text-[var(--ema-primary)]`} aria-hidden />}
      <div className="min-w-0">
        <p className="text-xs font-semibold text-[var(--ema-text-tertiary)]">{label}</p>
        <p className={cn(
          'font-semibold text-[var(--ema-text-primary)] tabular-nums truncate',
          size === 'lg' ? 'text-2xl font-bold' : 'text-base',
        )}>{isNum ? value.toLocaleString() : value}</p>
        {sub && <p className={cn('text-xs text-[var(--ema-text-tertiary)] mt-0.5', size === 'lg' && 'font-semibold opacity-60')}>{sub}</p>}
      </div>
    </div>
  );
}
