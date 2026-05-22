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
  | 'primary'         // Pink-white accented, signature action
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
  children?: ReactNode;
  /** HTMLButton's type — defaults to 'button' (we never want accidental form submits). */
  type?:     'button' | 'submit' | 'reset';
}

// ── Style tables ────────────────────────────────────────────────────────────

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-primary-500/20 hover:bg-primary-500/30 active:bg-primary-500/40 ' +
    'text-primary-100 border-primary-300/40 ' +
    'shadow-[0_0_12px_rgba(255,214,230,0.25)]',
  secondary:
    'bg-neutral-800/70 hover:bg-neutral-700/80 active:bg-neutral-700/90 ' +
    'text-neutral-100 border-neutral-600/40 backdrop-blur-sm',
  ghost:
    'bg-transparent hover:bg-neutral-700/40 active:bg-neutral-700/60 ' +
    'text-neutral-200 border-transparent',
  danger:
    'bg-red-500/20 hover:bg-red-500/30 active:bg-red-500/40 ' +
    'text-red-200 border-red-400/40',
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
          ? <span className="i-svg-spinners:ring-resize" aria-hidden />
          : icon
            ? <span className={icon} aria-hidden />
            : null}
        {children && <span>{children}</span>}
      </button>
    );
  },
);
