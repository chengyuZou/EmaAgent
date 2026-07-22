import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── MenuIconItem ─────────────────────────────────────────────────────────────
//
// Large settings-menu entry card (ported from AIRI's icon-item.vue):
// title + description on the left, oversized half-faded icon bleeding off
// the right edge. Hover: primary border, primary text, icon scales up and
// tints, a gradient light-sweep fades in from the left over a dotted
// texture. Token-driven - works in both light and dark themes.

export interface MenuIconItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  title:       string;
  description: string;
  /** UnoCSS icon class, e.g. "i-solar:settings-bold-duotone". */
  icon:        string;
}

export function MenuIconItem(props: MenuIconItemProps): React.JSX.Element {
  const { title, description, icon, className, ...rest } = props;

  return (
    <button
      type="button"
      className={cn(
        'group relative w-full flex items-center overflow-hidden box-border',
        'rounded-xl p-5 text-left cursor-pointer',
        'bg-[var(--ema-surface-1)] ema-glass-weak border-2 border-solid border-[var(--ema-border)]',
        'hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-2)]',
        'active:scale-[0.98]',
        'transition-all duration-[var(--ema-duration-base)] ease-in-out',
        // Light sweep (::before)
        'before:content-empty before:absolute before:inset-0 before:z-0',
        'before:w-1/4 before:h-full before:opacity-0',
        'before:transition-all before:duration-250 before:ease-in-out',
        'before:[mask-image:linear-gradient(120deg,white_30%,transparent_50%)]',
        'hover:before:opacity-100 hover:before:w-[85%]',
        'hover:before:bg-gradient-to-r hover:before:from-[var(--ema-primary)]/20 hover:before:via-[var(--ema-primary)]/10 hover:before:to-transparent',
        // Dotted texture (::after)
        'after:content-empty after:absolute after:inset-0 after:z-0 after:w-full after:h-full',
        'after:[background-image:radial-gradient(circle,var(--ema-text-tertiary)_1px,transparent_1px)]',
        'after:[background-size:10px_10px]',
        'after:[mask-image:linear-gradient(165deg,white_30%,transparent_50%)]',
        'after:transition-all after:duration-250',
        'after:opacity-25',
        className,
      )}
      {...rest}
    >
      <div className="relative z-1 flex-1 min-w-0">
        <div className="text-lg font-semibold text-[var(--ema-text-primary)] group-hover:text-[var(--ema-primary-text)] transition-all duration-[var(--ema-duration-base)] ease-in-out">
          {title}
        </div>
        <div className="text-sm text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-primary-text)]/80 transition-all duration-[var(--ema-duration-base)] ease-in-out">
          {description}
        </div>
      </div>
      <div
        aria-hidden
        className={cn(
          icon,
          'absolute right-0 size-24 translate-y-4 opacity-40',
          'text-[var(--ema-text-tertiary)] group-hover:text-[var(--ema-primary)] group-hover:scale-120',
          'transition-all duration-[var(--ema-duration-base)] ease-in-out',
        )}
      />
    </button>
  );
}
