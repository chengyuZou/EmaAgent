import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Button ──────────────────────────────────────────────────────────────────
//
// Standard rectangular(-ish, always rounded) button. For circular icon-only
// buttons (dock, send, toolbar) use <IconButton/>.
//
// Three-axis composition: variant × size × shape. All classes use UnoCSS
// atomic utilities; no inline style, no CSS file.

export type ButtonVariant =
  | 'primary'         // Water-blue accented, signature action
  | 'secondary'       // Neutral, frosted-glass look
  | 'ghost'           // Transparent, hover-only background
  | 'danger';         // Red, destructive

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
  /** UnoCSS icon class for the loading spinner. Defaults to a ring spinner. */
  loadingIcon?: string;
  children?: ReactNode;
  /** HTMLButton's type — defaults to 'button' (we never want accidental form submits). */
  type?:     'button' | 'submit' | 'reset';
}

// ── Style tables ────────────────────────────────────────────────────────────

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--ema-primary-muted)] hover:bg-[var(--ema-primary)]/30 active:bg-[var(--ema-primary)]/40 ' +
    'text-[var(--ema-primary-text)] border-[var(--ema-primary)]/40',
  secondary:
    'bg-[var(--ema-surface-3)] hover:bg-[var(--ema-surface-4)] active:bg-[var(--ema-surface-4)] ' +
    'text-[var(--ema-text-primary)] border-[var(--ema-border)] backdrop-blur-sm',
  ghost:
    'bg-transparent hover:bg-[var(--ema-surface-2)] active:bg-[var(--ema-surface-3)] ' +
    'text-[var(--ema-text-secondary)] hover:text-[var(--ema-text-primary)] border-transparent',
  danger:
    'bg-[var(--ema-danger-muted)] hover:bg-[var(--ema-danger)]/30 active:bg-[var(--ema-danger)]/40 ' +
    'text-[var(--ema-danger-text)] border-[var(--ema-danger)]/40',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-7  px-2.5 text-xs   gap-1',
  md: 'h-9  px-3.5 text-sm   gap-1.5',
  lg: 'h-11 px-5   text-base gap-2',
};

const SHAPE_CLASSES: Record<ButtonShape, string> = {
  rounded: 'rounded-md',
  pill:    'rounded-pill',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center font-medium border ' +
  'transition-ema cursor-pointer select-none ' +
  'disabled:cursor-not-allowed disabled:opacity-40 ' +
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
          ? <span className={loadingIcon ?? 'i-svg-spinners:ring-resize'} aria-hidden />
          : icon
            ? <span className={icon} aria-hidden />
            : null}
        {children}
      </button>
    );
  },
);
