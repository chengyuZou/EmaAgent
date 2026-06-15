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
  /** Custom icon colour class appended to the icon (e.g. "text-emerald-400"). */
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
        'rounded-xl bg-neutral-900/80 backdrop-blur-sm border-2 border-solid border-neutral-800/40',
        'hover:border-primary-400/30 hover:bg-neutral-900/95 hover:shadow-lg',
        'active:scale-[0.98]',
        'transition-all duration-250 ease-in-out',
        // Light sweep on hover (::before)
        'before:content-empty before:absolute before:inset-0 before:z-0',
        'before:w-1/4 before:h-full before:opacity-0',
        'before:transition-all before:duration-250 before:ease-in-out',
        'before:[mask-image:linear-gradient(120deg,white_30%,transparent_50%)]',
        'hover:before:opacity-100 hover:before:w-[85%]',
        'hover:before:bg-gradient-to-r hover:before:from-primary-400/20 hover:before:via-primary-400/10 hover:before:to-transparent',
        // Dotted texture (::after)
        'after:content-empty after:absolute after:inset-0 after:z-0 after:w-full after:h-full',
        'after:[background-image:radial-gradient(circle,rgba(115,115,115,0.25)_1px,transparent_1px)]',
        'after:[background-size:10px_10px]',
        'after:[mask-image:linear-gradient(165deg,white_30%,transparent_50%)]',
        'after:transition-all after:duration-250',
        className,
      )}
      {...rest}
    >
      {/* Text (padded like a card) */}
      <div className="relative z-1 flex-1 min-w-0 p-5 pb-3">
        <div className="text-lg font-normal text-neutral-100 group-hover:text-primary-300 transition-all duration-250 ease-in-out truncate">
          {title}
        </div>
        <div className="text-sm text-neutral-400 group-hover:text-primary-300/80 transition-all duration-250 ease-in-out truncate">
          {description ?? ''}
        </div>
      </div>

      {/* Icon — same strategy as MenuIconItem: peeks from right edge, centred vertically */}
      {icon && (
        <div
          aria-hidden
          className={cn(
            icon,
            'absolute right-0 top-1/2 -translate-y-1/2 size-16 opacity-50',
            'text-neutral-600/50 group-hover:text-primary-400 group-hover:opacity-70 group-hover:scale-110',
            'transition-all duration-250 ease-in-out',
            iconColor,
          )}
        />
      )}

      {/* Status strip */}
      <div className="relative z-1 p-2">
        {configured
          ? <div className="size-4 rounded-full bg-green-500 shadow-lg" />
          : <div className="size-4 rounded-full bg-neutral-900 border-2 border-solid border-neutral-700" />}
      </div>
    </button>
  );
}
