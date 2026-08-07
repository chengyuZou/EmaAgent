import type { JSX } from 'react';
import { cn } from '../utils/cn.js';

// ── EmptyState ───────────────────────────────────────────────────────────────
// 居中图标 + 标题 + 可选提示,用于空态/加载兜底,替代设置页散落的裸 div 空态。

export interface EmptyStateProps {
  /** UnoCSS icon class, e.g. "i-mdi:store-outline". */
  icon?:     string;
  title:     string;
  hint?:     string;
  /** Add `ema-fade-in` entrance animation. */
  animate?:  boolean;
  /** sm = compact (text-2xl icon, py-6), md = default (text-4xl icon, py-12). */
  size?:     'sm' | 'md';
  className?: string;
}

export function EmptyState({ icon, title, hint, animate, size = 'md', className }: EmptyStateProps): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2', size === 'sm' ? 'py-6' : 'py-12', animate && 'ema-fade-in', className)}>
      {icon && <span className={cn(icon, 'opacity-40', size === 'sm' ? 'text-2xl' : 'text-4xl')} aria-hidden />}
      <p className="text-sm text-[var(--ema-text-tertiary)]">{title}</p>
      {hint && <p className="text-xs text-[var(--ema-text-tertiary)] opacity-70">{hint}</p>}
    </div>
  );
}
