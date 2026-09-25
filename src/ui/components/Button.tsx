import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Button ──────────────────────────────────────────────────────────────────
//
// 标准矩形按钮(始终圆角);圆形纯图标按钮(工具栏/发送)请用 <IconButton/>。
// 三轴组合:variant × size × shape,全部走 UnoCSS 原子类。

export type ButtonVariant =
  | 'primary'         // 主题色强调,签名级动作
  | 'secondary'       // 中性,轻玻璃质感
  | 'ghost'           // 透明,仅 hover 出底
  | 'danger';         // 红色,破坏性操作

export type ButtonSize  = 'sm' | 'md' | 'lg';
export type ButtonShape = 'rounded' | 'pill';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?:  ButtonVariant;
  size?:     ButtonSize;
  shape?:    ButtonShape;
  loading?:  boolean;
  /** Stretches button to 100% width. */
  block?:    boolean;
  /** UnoCSS icon class (e.g. "i-mdi:home") rendered left of label. */
  icon?:     string;
  /** UnoCSS icon class for the loading spinner. Defaults to the three-dot bounce. */
  loadingIcon?: string;
  children?: ReactNode;
  /** HTMLButton's type — defaults to 'button' (we never want accidental form submits). */
  type?:     'button' | 'submit' | 'reset';
}

// ── Style tables ────────────────────────────────────────────────────────────

// B 壳: 1px 描边 + 内顶高光(inset 0 1px 0) + 薄影; pressed 统一 scale(.97).
// disabled 分变体: 填充系换不透明灰块+三级字(半透明会读成"加载中"), 透明系才降透明度.
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-[color-mix(in_srgb,var(--ema-primary)_24%,transparent)] hover:bg-[color-mix(in_srgb,var(--ema-primary)_32%,transparent)] active:bg-[color-mix(in_srgb,var(--ema-primary)_38%,transparent)] ' +
    'text-[var(--ema-primary-text)] border-[color-mix(in_srgb,var(--ema-primary)_45%,transparent)] ' +
    'shadow-[0_2px_10px_-4px_var(--ema-primary),inset_0_1px_0_rgba(255,255,255,0.10)] hover:shadow-[0_3px_14px_-4px_var(--ema-primary),inset_0_1px_0_rgba(255,255,255,0.12)] ' +
    'disabled:bg-[var(--ema-surface-2)] disabled:text-[var(--ema-text-tertiary)] disabled:border-[var(--ema-border)] disabled:shadow-none',
  secondary:
    'bg-[var(--ema-surface-3)] hover:bg-[var(--ema-surface-4)] active:bg-[var(--ema-surface-4)] ' +
    'text-[var(--ema-text-primary)] border-[var(--ema-border)] hover:border-[var(--ema-border-strong)] backdrop-blur-sm ' +
    'shadow-[var(--ema-shadow-1),inset_0_1px_0_rgba(255,255,255,0.06)] ' +
    'disabled:bg-[var(--ema-surface-2)] disabled:text-[var(--ema-text-tertiary)] disabled:border-[var(--ema-border)] disabled:shadow-none',
  ghost:
    'bg-transparent hover:bg-[var(--ema-surface-2)] active:bg-[var(--ema-surface-3)] ' +
    'text-[var(--ema-text-secondary)] hover:text-[var(--ema-text-primary)] border-transparent shadow-none ' +
    'disabled:opacity-50',
  danger:
    'bg-[color-mix(in_srgb,var(--ema-danger)_16%,transparent)] hover:bg-[color-mix(in_srgb,var(--ema-danger)_24%,transparent)] active:bg-[color-mix(in_srgb,var(--ema-danger)_30%,transparent)] ' +
    'text-[var(--ema-danger-text)] border-[color-mix(in_srgb,var(--ema-danger)_42%,transparent)] ' +
    'shadow-[var(--ema-shadow-1),inset_0_1px_0_rgba(255,255,255,0.06)] ' +
    'disabled:bg-[var(--ema-surface-2)] disabled:text-[var(--ema-text-tertiary)] disabled:border-[var(--ema-border)] disabled:shadow-none',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-7  px-2.5 text-xs   gap-1',
  md: 'h-9  px-3.5 text-sm   gap-1.5',
  lg: 'h-11 px-5   text-base gap-2',
};

const SHAPE_CLASSES: Record<ButtonShape, string> = {
  rounded: 'rounded-lg',
  pill:    'rounded-pill',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center font-medium border whitespace-nowrap ' +
  'transition-ema cursor-pointer select-none active:scale-[0.97] ' +
  'disabled:cursor-not-allowed ' +
  'focus-ring';

// ── Component ───────────────────────────────────────────────────────────────

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(props, ref) {
    const {
      variant  = 'secondary',
      size     = 'md',
      shape    = 'rounded',
      loading  = false,
      block    = false,
      icon,
      loadingIcon,
      children,
      type     = 'button',
      disabled,
      className,
      ...rest
    } = props;

    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={cn(
          BASE_CLASSES,
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          SHAPE_CLASSES[shape],
          block && 'w-full',
          className,
        )}
        {...rest}
      >
        {loading
          ? <span className={loadingIcon ?? 'i-svg-spinners:3-dots-fade'} aria-hidden />
          : icon
            ? <span className={icon} aria-hidden />
            : null}
        {children}
      </button>
    );
  },
);
