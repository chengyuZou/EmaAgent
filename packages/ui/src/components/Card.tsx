import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── Card ────────────────────────────────────────────────────────────────────

export type CardVariant = 'default' | 'elevated' | 'glass';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
}

const VARIANT_CLASSES: Record<CardVariant, string> = {
  default:  'bg-[var(--ema-surface-1)] border border-[var(--ema-border)]',
  elevated: 'bg-[var(--ema-surface-1)] border border-[var(--ema-border-strong)] shadow-[var(--ema-shadow-1)]',
  glass:    'bg-[var(--ema-surface-1)] ema-glass-weak border border-[var(--ema-border)]',
};

const PADDING_CLASSES: Record<CardPadding, string> = {
  none: '',
  sm:   'p-3',
  md:   'p-4',
  lg:   'p-6',
};

export const Card = forwardRef<HTMLDivElement, CardProps>(
  function Card(props, ref) {
    const { variant = 'default', padding = 'md', className, children, ...rest } = props;
    return (
      <div
        ref={ref}
        className={cn('rounded-md', VARIANT_CLASSES[variant], PADDING_CLASSES[padding], className)}
        {...rest}
      >
        {children}
      </div>
    );
  },
);
