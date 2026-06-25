import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Badge ───────────────────────────────────────────────────────────────────
//
// Small chip / tag. Use for status indicators, counts, mode labels.
// `dot=true` renders a minimal colored circle (used in status bars).

export type BadgeVariant = 'neutral' | 'primary' | 'violet' | 'success' | 'warn' | 'danger';

export interface BadgeProps {
  variant?:   BadgeVariant;
  dot?:       boolean;
  children?:  ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<BadgeVariant, { bg: string; text: string; dot: string }> = {
  neutral: { bg: 'bg-[var(--ema-surface-2)]',  text: 'text-[var(--ema-text-secondary)]', dot: 'bg-[var(--ema-text-tertiary)]' },
  primary: { bg: 'bg-primary-500/25',  text: 'text-primary-100', dot: 'bg-primary-300' },
  violet:  { bg: 'bg-violet-500/25',   text: 'text-violet-100',  dot: 'bg-violet-300'  },
  success: { bg: 'bg-green-500/20',    text: 'text-green-200',   dot: 'bg-green-400'   },
  warn:    { bg: 'bg-amber-500/20',    text: 'text-amber-200',   dot: 'bg-amber-400'   },
  danger:  { bg: 'bg-red-500/20',      text: 'text-red-200',     dot: 'bg-red-400'     },
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
