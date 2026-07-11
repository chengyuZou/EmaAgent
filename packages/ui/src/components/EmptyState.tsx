import type { JSX } from 'react';
import { cn } from '../utils/cn.js';

// ── EmptyState ───────────────────────────────────────────────────────────────
//
// Centered icon + title + optional hint, for empty/loading-fallback states.
// Replaces the scattered bare <div>/<p> empty states across settings tabs.

export interface EmptyStateProps {
  /** UnoCSS icon class, e.g. "i-mdi:store-outline". */
  icon?:     string;
  title:     string;
  hint?:     string;
  /** Add `ema-fade-in` entrance animation. */
  animate?:  boolean;
  className?: string;
}

export function EmptyState({ icon, title, hint, animate, className }: EmptyStateProps): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-12', animate && 'ema-fade-in', className)}>
      {icon && <span className={`${icon} text-4xl opacity-40`} aria-hidden />}
      <p className="text-sm text-[var(--ema-text-tertiary)]">{title}</p>
      {hint && <p className="text-xs text-[var(--ema-text-tertiary)] opacity-70">{hint}</p>}
    </div>
  );
}
