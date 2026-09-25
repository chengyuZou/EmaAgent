import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── Input ───────────────────────────────────────────────────────────────────
export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Renamed to avoid clashing with native `size` attribute. */
  inputSize?: InputSize;
  error?:     boolean;
  /** 机器值(URL/key/ID/数字/路径)用 mono(默认); 人类文本(名称/描述)传 false 走正文栈. */
  mono?:      boolean;
}

const SIZE_CLASSES: Record<InputSize, string> = {
  sm: 'h-7  px-2.5 text-xs',
  md: 'h-9  px-3   text-sm',
  lg: 'h-11 px-3.5 text-base',
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input(props, ref) {
    const { inputSize = 'md', error, mono = true, className, type = 'text', ...rest } = props;
    return (
      <input
        ref={ref}
        type={type}
        aria-invalid={error || undefined}
        className={cn(
          'w-full rounded-xl border text-[var(--ema-text-primary)] placeholder:text-[var(--ema-text-tertiary)]',
          mono && 'font-mono',
          'bg-[var(--ema-control-bg)] shadow-[var(--ema-control-shadow)]',
          'hover:bg-[var(--ema-control-bg-hover)] focus-visible:bg-[var(--ema-control-bg-focus)]',
          'transition-ema',
          'disabled:cursor-not-allowed disabled:opacity-50',
          SIZE_CLASSES[inputSize],
          // 去掉原生数字步进箭头(↕)——暗色 UI 里格格不入,
          // 数值直接手输。
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
