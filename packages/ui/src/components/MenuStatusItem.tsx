import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── MenuStatusItem ───────────────────────────────────────────────────────────
//
// Provider-style grid card (ported from AIRI's icon-status-item.vue):
// title + description, a grayscale icon on the right that regains color on
// hover, and a configured/unconfigured status dot in the bottom strip.

export interface MenuStatusItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  title:        string;
  description?: string;
  /** UnoCSS icon class, e.g. "i-mdi:robot-outline". */
  icon?:        string;
  /** Custom icon color class appended to the icon (e.g. "text-emerald-400"). */
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
        'rounded-xl bg-neutral-800/60 border-2 border-solid border-neutral-800/25',
        'hover:border-primary-400/30',
        'transition-all duration-400 ease-in-out',
        // Light sweep on hover
        'before:content-empty before:absolute before:inset-0 before:z-0',
        'before:w-1/4 before:h-full before:opacity-0',
        'before:transition-all before:duration-400 before:ease-in-out',
        'hover:before:opacity-100 hover:before:w-1/2',
        'hover:before:bg-gradient-to-r hover:before:from-primary-400/20 hover:before:via-primary-400/10 hover:before:to-transparent',
        className,
      )}
      {...rest}
    >
      {/* Inner panel */}
      <div
        className={cn(
          'relative w-full flex items-center overflow-hidden rounded-lg p-5 bg-neutral-900',
          'transition-all duration-400 ease-in-out',
          // Dotted texture
          'after:content-empty after:absolute after:inset-0 after:z-0 after:w-full after:h-full',
          'after:[background-image:radial-gradient(circle,rgba(115,115,115,0.3)_1px,transparent_1px)]',
          'after:[background-size:10px_10px]',
          'after:[mask-image:linear-gradient(165deg,white_30%,transparent_50%)]',
        )}
      >
        <div className="relative z-1 flex-1 min-w-0">
          <div className="text-lg font-normal text-neutral-100 group-hover:text-primary-300 transition-all duration-400 ease-in-out truncate">
            {title}
          </div>
          <div className="text-sm text-neutral-400 group-hover:text-primary-300/80 transition-all duration-400 ease-in-out truncate">
            {description ?? ''}
          </div>
        </div>
        {icon && (
          <div
            aria-hidden
            className={cn(
              icon,
              'absolute right-0 size-16 translate-y-2 grayscale-100 group-hover:grayscale-0',
              'text-neutral-600/50 group-hover:text-primary-400',
              'transition-all duration-400 ease-in-out',
              iconColor,
            )}
          />
        )}
      </div>

      {/* Status strip */}
      <div className="p-2">
        {configured
          ? <div className="size-4 rounded-full bg-green-500 shadow-lg" />
          : <div className="size-4 rounded-full bg-neutral-900 border-2 border-solid border-neutral-700" />}
      </div>
    </button>
  );
}
