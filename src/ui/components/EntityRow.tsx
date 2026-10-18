import type { CSSProperties, JSX, ReactNode } from 'react';
import { cn } from '../utils/cn.js';

export interface EntityRowProps {
  /** `ema-card-decorate--xxx` variant. */
  decorate?: string;
  /** Selected state: primary border + primary-muted bg. */
  selected?: boolean;
  /** If given, renders a <button> (clickable row). */
  onClick?:  () => void;
  /** Stagger index for `ema-stagger-in`. */
  index?:    number;
  /** Padding + flex layout (e.g. "p-5 flex flex-col gap-3"). */
  className?: string;
  children:  ReactNode;
}

export function EntityRow({ decorate, selected, onClick, index, className, children }: EntityRowProps): JSX.Element {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'ema-stagger-in ema-glass-weak ema-card-decorate bg-[var(--ema-surface-1)] rounded-xl border border-solid text-left transition-ema focus-ring',
        onClick && 'cursor-pointer select-none',
        selected
          ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
          : 'border-[var(--ema-border)] hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]',
        decorate,
        className,
      )}
      style={{ '--stagger-i': index } as CSSProperties}
    >
      {children}
    </Comp>
  );
}
