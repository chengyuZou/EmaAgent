import type { JSX } from 'react';
import { cn } from '../utils/cn.js';

// ── RadioDot ─────────────────────────────────────────────────────────────────
// 单选圆点: 未选中为空心环, 选中时填充主色内点(内点 spring 弹入).

export interface RadioDotProps {
  selected: boolean;
  className?: string;
}

export function RadioDot({ selected, className }: RadioDotProps): JSX.Element {
  return (
    <span className={cn(
      'size-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-ema',
      selected ? 'border-[var(--ema-primary)]' : 'border-[var(--ema-border-strong)]',
      className,
    )}>
      <span
        className={cn(
          'size-2 rounded-full bg-[var(--ema-primary)]',
          'transition-transform duration-[var(--ema-duration-fast)] ease-[var(--ema-ease-spring)]',
          selected ? 'scale-100' : 'scale-0',
        )}
      />
    </span>
  );
}
