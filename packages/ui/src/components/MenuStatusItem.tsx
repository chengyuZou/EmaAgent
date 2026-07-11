import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── MenuStatusItem ───────────────────────────────────────────────────────────
//
// Provider-style grid card (ported from AIRI's icon-status-item.vue):
// title + description, a grayscale icon peeking from the right edge that
// regains colour on hover, and a configured/unconfigured status dot in
// the bottom strip.
//
// Structure is intentionally FLAT (same as MenuIconItem): the icon sits
// directly in the button, not in a nested overflow-hidden panel. Only one
// overflow-hidden layer clips the icon, so the right-edge peek-through
// works the same way as the main-menu cards.

export interface MenuStatusItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  title:        string;
  description?: string;
  /** UnoCSS icon class, e.g. "i-mdi:robot-outline". */
  icon?:        string;
  /** Custom icon colour class appended to the icon (e.g. "text-[var(--ema-success)]"). */
  iconColor?:   string;
  /** Filled green dot when true, hollow ring when false. */
  configured?:  boolean;
}

export function MenuStatusItem(props: MenuStatusItemProps): React.JSX.Element {
  const { title, description, icon, iconColor, configured = false, className, ...rest } = props;

  return (
    <button
      type="button"
      className={cn(
        'group relative w-full flex flex-col overflow-hidden box-border text-left cursor-pointer',
        'rounded-xl bg-[var(--ema-surface-1)] ema-glass-weak border-2 border-solid border-[var(--ema-border)]',
        'hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]',
        'active:scale-[0.98]',
        'transition-all duration-[var(--ema-duration-base)] ease-in-out',
        // Light sweep on hover (::before)
        'before:content-empty before:absolute before:inset-0 before:z-0',
        'before:w-1/4 before:h-full before:opacity-0',
        'before:transition-all before:duration-250 before:ease-in-out',
        'before:[mask-image:linear-gradient(120deg,white_30%,transparent_50%)]',
        'hover:before:opacity-100 hover:before:w-[85%]',
        'hover:before:bg-gradient-to-r hover:before:from-[var(--ema-primary)]/20 hover:before:via-[var(--ema-primary)]/10 hover:before:to-transparent',
        // Dotted texture (::after)
        'after:content-empty after:absolute after:inset-0 after:z-0 after:w-full after:h-full',
        'after:[background-image:radial-gradient(ellipse_70%_50%_at_40%_50%,color-mix(in_srgb,var(--ema-text-tertiary)_16%,transparent)_0%,transparent_60%),radial-gradient(ellipse_60%_45%_at_60%_50%,color-mix(in_srgb,var(--ema-text-tertiary)_14%,transparent)_0%,transparent_65%)]',
        'after:[background-size:100%_100%,100%_100%]',
        'after:[mask-image:linear-gradient(165deg,white_30%,transparent_50%)]',
        'after:transition-all after:duration-250',
        'after:opacity-25',
        className,
      )}
      {...rest}
    >
      {/* Text (padded like a card) */}
      <div className="relative z-1 flex-1 min-w-0 p-5 pb-3">
        <div className="text-lg font-semibold text-[var(--ema-text-primary)] group-hover:text-[var(--ema-primary-text)] transition-all duration-[var(--ema-duration-base)] ease-in-out truncate">
          {title}
        </div>
        <div className="text-sm text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-primary-text)]/80 transition-all duration-[var(--ema-duration-base)] ease-in-out truncate">
          {description ?? ''}
        </div>
      </div>

      {/* Icon — same strategy as MenuIconItem: peeks from right edge, centred vertically */}
      {icon && (
        <div
          aria-hidden
          className={cn(
            icon,
            'absolute right-0 top-1/2 -translate-y-1/2 size-16 opacity-40',
            'text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-primary)] group-hover:opacity-70 group-hover:scale-110',
            'transition-all duration-[var(--ema-duration-base)] ease-in-out',
            iconColor,
          )}
        />
      )}

      {/* Status strip */}
      <div className="relative z-1 p-2">
        {configured
          ? <div className="size-4 rounded-full bg-[var(--ema-success)] shadow-lg" />
          : <div className="size-4 rounded-full bg-[var(--ema-surface-2)] border-2 border-solid border-[var(--ema-border-strong)]" />}
      </div>
    </button>
  );
}
