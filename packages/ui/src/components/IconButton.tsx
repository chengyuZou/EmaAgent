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
  /** UnoCSS icon class for the loading spinner. Defaults to a ring spinner. */
  loadingIcon?: string;
  type?:      'button' | 'submit' | 'reset';
}

// ── Style tables ────────────────────────────────────────────────────────────

const VARIANT_CLASSES: Record<IconButtonVariant, { idle: string; toggled: string }> = {
  default: {
    idle:    'bg-[var(--ema-surface-3)] hover:bg-[var(--ema-primary-muted)] hover:border-[var(--ema-primary)]/40 text-[var(--ema-text-primary)] border-[var(--ema-border)]',
    toggled: 'bg-[var(--ema-primary-muted)] border-[var(--ema-primary)]/70 text-[var(--ema-primary-text)] shadow-[var(--ema-shadow-focus)]',
  },
  primary: {
    idle:    'bg-[var(--ema-primary-muted)] hover:bg-[var(--ema-primary)]/45 text-[var(--ema-primary-text)] border-[var(--ema-primary)]/50',
    toggled: 'bg-[var(--ema-primary)] border-[var(--ema-primary)]/80 text-[var(--ema-primary-text)] shadow-[var(--ema-shadow-focus)]',
  },
  danger: {
    idle:    'bg-[var(--ema-surface-3)] hover:bg-[var(--ema-danger)]/60 hover:border-[var(--ema-danger)]/60 text-[var(--ema-text-primary)] hover:text-white border-[var(--ema-border)]',
    toggled: 'bg-[var(--ema-danger)]/60 border-[var(--ema-danger)]/70 text-white',
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
      loadingIcon,
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
          ? <span className={cn(loadingIcon ?? 'i-svg-spinners:ring-resize', sizeCfg.icon)} aria-hidden />
          : icon
            ? <span className={cn(icon, sizeCfg.icon)} aria-hidden />
            : <span className={sizeCfg.icon} aria-hidden>{iconNode}</span>}
      </button>
    );
  },
);
