import type { JSX } from 'react';
import { cn } from '../utils/cn.js';

// ── RadioDot ─────────────────────────────────────────────────────────────────
// 单选圆点:未选中为空心环,选中时填充主色内点。

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
