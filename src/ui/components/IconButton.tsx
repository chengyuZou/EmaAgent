import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── IconButton ──────────────────────────────────────────────────────────────
//
// 纯图标按钮(FloatingDock / 聊天输入框内嵌发送 / 工具栏附件 / 消息动作).
// 与 Button 的差异: 内容用 icon 类或 iconNode, label 必填(无障碍), 不渲染可见文本,
// tooltip 由调用方负责.
// 外壳两档: circle(默认, 工具栏/发送) / rounded(圆角小芯片, 消息动作/行内弱操作).

export type IconButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';
export type IconButtonSize    = 'sm' | 'md' | 'lg';
export type IconButtonShape   = 'circle' | 'rounded';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  /** Screen-reader label (and tooltip text consumers will mirror). */
  label:      string;
  /** UnoCSS icon class name (e.g. "i-mdi:close"). Mutually exclusive with `iconNode`. */
  icon?:      string;
  /** Alternative: render a ReactNode (e.g. inline SVG, emoji). */
  iconNode?:      ReactNode;
  variant?:   IconButtonVariant;
  size?:      IconButtonSize;
  /** 外壳: circle=正圆(默认), rounded=圆角小芯片(半径绑尺寸档, 消息动作/行内弱操作用). */
  shape?:     IconButtonShape;
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
    // 签名级动作(发送等):实心主色 + 同色系柔影常驻,hover 只提亮抬影。
    idle:    'bg-[var(--ema-primary)] text-[var(--ema-text-inverse)] border-[var(--ema-primary)]/80 shadow-[var(--ema-shadow-cta)] hover:brightness-105 hover:shadow-[var(--ema-shadow-cta-hover)]',
    toggled: 'bg-[var(--ema-primary)] border-[var(--ema-primary)]/80 text-[var(--ema-text-inverse)] shadow-[var(--ema-shadow-cta)]',
  },
  danger: {
    idle:    'bg-[var(--ema-surface-3)] hover:bg-[var(--ema-danger)]/60 hover:border-[var(--ema-danger)]/60 text-[var(--ema-text-primary)] hover:text-[var(--ema-text-inverse)] border-[var(--ema-border)]',
    toggled: 'bg-[var(--ema-danger)]/60 border-[var(--ema-danger)]/70 text-[var(--ema-text-inverse)]',
  },
  // 裸态小图标钮(聊天工具栏/标签关闭/行内动作):默认透明, hover 才显底, 与 ema-chat-icon-btn 同语言。
  ghost: {
    idle:    'bg-transparent border-transparent text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)]',
    toggled: 'bg-[var(--ema-primary-muted)] border-[color-mix(in_srgb,var(--ema-primary)_40%,transparent)] text-[var(--ema-primary-text)]',
  },
};

const SIZE_CLASSES: Record<IconButtonSize, { box: string; icon: string }> = {
  sm: { box: 'w-7  h-7',  icon: 'text-base' },
  md: { box: 'w-9  h-9',  icon: 'text-lg' },
  lg: { box: 'w-11 h-11', icon: 'text-xl' },
};

// rounded 外壳的半径绑尺寸档(约 1/4~1/3 边长): 小方芯片, 不是加宽矩形.
const ROUNDED_RADIUS: Record<IconButtonSize, string> = {
  sm: 'rounded-[8px]',
  md: 'rounded-[10px]',
  lg: 'rounded-[12px]',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center border ' +
  'transition-ema cursor-pointer select-none ' +
  'active:scale-92 ' +
  'disabled:cursor-not-allowed disabled:opacity-40 ' +
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
      shape   = 'circle',
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
          shape === 'circle' ? 'rounded-full' : ROUNDED_RADIUS[size],
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
