import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── IconButton ──────────────────────────────────────────────────────────────
//
// Forced-circular button used wherever an action is icon-only:
//   - FloatingDock buttons
//   - Chat input embedded send button (textarea bottom-right iconNode)
//   - Toolbar attachments / mic / TTS toggle
//
// Differences from <Button/>:
//   - Always circular (rounded-full, locked aspect-ratio 1:1)
//   - Children replaced by `icon` (string class) or `iconNode` (ReactNode for SVG)
//   - `label` is required for accessibility (aria-label)
//   - No text content rendered visually; tooltip is consumer's responsibility

export type IconButtonVariant = 'default' | 'primary' | 'danger';
export type IconButtonSize    = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  /** Screen-reader label (and tooltip text consumers will mirror). */
  label:      string;
  /** UnoCSS icon class name (e.g. "i-mdi:close"). Mutually exclusive with `iconNode`. */
  icon?:      string;
  /** Alternative: render a ReactNode (e.g. inline SVG, emoji). */
  iconNode?:      ReactNode;
  variant?:   IconButtonVariant;
  size?:      IconButtonSize;
  /** Visual "on" state — highlighted background + glow. */
  toggled?:   boolean;
  loading?:   boolean;
  type?:      'button' | 'submit' | 'reset';
}

// ── Style tables ────────────────────────────────────────────────────────────

const VARIANT_CLASSES: Record<IconButtonVariant, { idle: string; toggled: string }> = {
  default: {
    idle:    'bg-neutral-800/55 hover:bg-primary-200/22 hover:border-primary-300/40 text-neutral-100 border-neutral-700/50',
    toggled: 'bg-primary-200/45 border-primary-300/70 text-primary-50 shadow-[0_0_12px_rgba(255,214,230,0.45)]',
  },
  primary: {
    idle:    'bg-primary-500/30 hover:bg-primary-500/45 text-primary-100 border-primary-300/50',
    toggled: 'bg-primary-400/60 border-primary-200/80 text-primary-50 shadow-[0_0_14px_rgba(255,214,230,0.55)]',
  },
  danger: {
    idle:    'bg-neutral-800/55 hover:bg-red-500/60 hover:border-red-300/60 text-neutral-100 hover:text-white border-neutral-700/50',
    toggled: 'bg-red-500/60 border-red-300/70 text-white',
  },
};

const SIZE_CLASSES: Record<IconButtonSize, { box: string; icon: string }> = {
  sm: { box: 'w-7  h-7',  icon: 'text-base' },
  md: { box: 'w-9  h-9',  icon: 'text-lg' },
  lg: { box: 'w-11 h-11', icon: 'text-xl' },
};

const BASE_CLASSES =
  'inline-flex items-center justify-center rounded-full border ' +
  'transition-ema cursor-pointer select-none ' +
  'active:scale-92 hover:scale-108 ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100 ' +
  'focus-ring';

// ── Component ───────────────────────────────────────────────────────────────

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(props, ref) {
    const {
      label,
      icon,
      iconNode,
      variant = 'default',
      size    = 'md',
      toggled = false,
      loading = false,
      type    = 'button',
      disabled,
      className,
      ...rest
    } = props;

    const isDisabled = disabled || loading;
    const sizeCfg    = SIZE_CLASSES[size];
    const variantCfg = VARIANT_CLASSES[variant];

    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={toggled || undefined}
        aria-busy={loading || undefined}
        disabled={isDisabled}
        className={cn(
          BASE_CLASSES,
          sizeCfg.box,
          toggled ? variantCfg.toggled : variantCfg.idle,
          className,
        )}
        {...rest}
      >
        {loading
          ? <span className={cn('i-svg-spinners:ring-resize', sizeCfg.icon)} aria-hidden />
          : icon
            ? <span className={cn(icon, sizeCfg.icon)} aria-hidden />
            : <span className={sizeCfg.icon} aria-hidden>{iconNode}</span>}
      </button>
    );
  },
);
