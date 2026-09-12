import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── Input ───────────────────────────────────────────────────────────────────
export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Renamed to avoid clashing with native `size` attribute. */
  inputSize?: InputSize;
  error?:     boolean;
}

const SIZE_CLASSES: Record<InputSize, string> = {
  sm: 'h-7  px-2.5 text-xs',
  md: 'h-9  px-3   text-sm',
  lg: 'h-11 px-3.5 text-base',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input(props, ref) {
    const { inputSize = 'md', error, className, type = 'text', ...rest } = props;
    return (
      <input
        ref={ref}
        type={type}
        aria-invalid={error || undefined}
        className={cn(
          'w-full rounded-xl border font-mono text-[var(--ema-text-primary)] placeholder:text-[var(--ema-text-tertiary)]',
          'bg-[var(--ema-control-bg)] shadow-[var(--ema-control-shadow)]',
          'hover:bg-[var(--ema-control-bg-hover)] focus-visible:bg-[var(--ema-control-bg-focus)]',
          'transition-ema',
          'disabled:cursor-not-allowed disabled:opacity-50',
          SIZE_CLASSES[inputSize],
          // Strip the native number-spinner arrows (↕) — they look out of place
          // in the dark UI; users type the value directly.
          type === 'number' &&
            '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
          error
            ? 'border-[var(--ema-danger)] focus-visible:shadow-[var(--ema-shadow-danger)]'
            : 'border-[var(--ema-control-border)] hover:border-[var(--ema-control-border-hover)] focus-visible:border-[var(--ema-control-border-focus)] focus-visible:shadow-[var(--ema-control-shadow-focus)]',
          className,
        )}
        {...rest}
      />
    );
  },
);
