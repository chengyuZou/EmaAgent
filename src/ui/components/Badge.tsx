import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Badge ───────────────────────────────────────────────────────────────────
// 小徽标/标签:状态、计数、模式标识;dot=true 时渲染纯色圆点(状态条用)。

export type BadgeVariant = 'neutral' | 'primary' | 'violet' | 'success' | 'warn' | 'danger';

export interface BadgeProps {
  variant?:   BadgeVariant;
  dot?:       boolean;
  children?:  ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<BadgeVariant, { bg: string; text: string; dot: string }> = {
  neutral: { bg: 'bg-[var(--ema-surface-2)]',  text: 'text-[var(--ema-text-secondary)]', dot: 'bg-[var(--ema-text-tertiary)]' },
  primary: { bg: 'bg-[var(--ema-primary-muted)]', text: 'text-[var(--ema-primary-text)]', dot: 'bg-[var(--ema-primary)]' },
  violet:  { bg: 'bg-[var(--ema-violet-muted)]',  text: 'text-[var(--ema-violet-text)]',  dot: 'bg-[var(--ema-violet)]'  },
  success: { bg: 'bg-[var(--ema-success-muted)]', text: 'text-[var(--ema-success-text)]', dot: 'bg-[var(--ema-success)]' },
  warn:    { bg: 'bg-[var(--ema-warning-muted)]', text: 'text-[var(--ema-warning-text)]', dot: 'bg-[var(--ema-warning)]' },
  danger:  { bg: 'bg-[var(--ema-danger-muted)]',  text: 'text-[var(--ema-danger-text)]',  dot: 'bg-[var(--ema-danger)]'  },
};

export function Badge(props: BadgeProps): React.JSX.Element {
  const { variant = 'neutral', dot, children, className } = props;
  const v = VARIANT_CLASSES[variant];

  if (dot && !children) {
    return (
      <span
        className={cn('inline-block w-2 h-2 rounded-full', v.dot, className)}
        aria-hidden
      />
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-xs font-medium',
        v.bg, v.text, className,
      )}
    >
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full', v.dot)} aria-hidden />}
      {children}
    </span>
  );
}
