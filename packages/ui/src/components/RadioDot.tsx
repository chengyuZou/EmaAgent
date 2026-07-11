import type { JSX } from 'react';
import { cn } from '../utils/cn.js';

// ── RadioDot ─────────────────────────────────────────────────────────────────
//
// Radio selection dot: ring + inner dot when selected.
// Replaces the duplicate radio dot markup in BindingsTab (provider card + model card).

export interface RadioDotProps {
  selected: boolean;
  className?: string;
}

export function RadioDot({ selected, className }: RadioDotProps): JSX.Element {
  return (
    <span className={cn(
      'size-4 rounded-full border-2 flex items-center justify-center flex-shrink-0',
      selected ? 'border-[var(--ema-primary)]' : 'border-[var(--ema-border-strong)]',
      className,
    )}>
      {selected && <span className="size-2 rounded-full bg-[var(--ema-primary)]" />}
    </span>
  );
}
