import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── CardButton ───────────────────────────────────────────────────────────────
// 可点击卡片:供应商选择/模型网格/会话行等"整卡即按钮"场景,
// 自带 selected 状态(主色描边 + muted 底色),token 驱动,明暗安全。

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
