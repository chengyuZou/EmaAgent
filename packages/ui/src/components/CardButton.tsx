import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── CardButton ───────────────────────────────────────────────────────────────
//
// Clickable card. For "card-as-button" selection patterns (provider picker,
// model grid, session row, swatch) where raw <button> + card styles would be
// re-implemented per call site. Carries an optional `selected` state
// (primary border + muted bg). Token-driven, light/dark safe.

export type CardButtonPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Selected state: primary border + primary-muted background. */
  selected?: boolean;
  padding?:  CardButtonPadding;
  type?:     'button' | 'submit' | 'reset';
}

const PADDING_CLASSES: Record<CardButtonPadding, string> = {
  none: '',
  sm:   'p-3',
  md:   'p-4',
  lg:   'p-6',
};

export const CardButton = forwardRef<HTMLButtonElement, CardButtonProps>(
  function CardButton(props, ref) {
    const { selected = false, padding = 'md', className, type = 'button', ...rest } = props;
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          'text-left rounded-md border-2 border-solid transition-ema cursor-pointer select-none',
          'bg-[var(--ema-surface-1)] border-[var(--ema-border)]',
          'hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]',
          'active:scale-[0.99] focus-ring',
          selected && 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)]',
          PADDING_CLASSES[padding],
          className,
        )}
        {...rest}
      />
    );
  },
);
