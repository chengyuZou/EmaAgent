import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── Input ───────────────────────────────────────────────────────────────────
//
// Single-line text input. Uses controlled or uncontrolled depending on
// whether `value` is provided (standard React semantics).

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
          'w-full rounded-md border bg-neutral-900/60 text-neutral-100 placeholder:text-neutral-500',
          'transition-ema focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          SIZE_CLASSES[inputSize],
          // Strip the native number-spinner arrows (↕) — they look out of place
          // in the dark UI; users type the value directly.
          type === 'number' &&
            '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
          error
            ? 'border-red-400/60 focus-visible:ring-red-400'
            : 'border-neutral-700/50 hover:border-neutral-600 focus-visible:border-primary-300',
          className,
        )}
        {...rest}
      />
    );
  },
);
