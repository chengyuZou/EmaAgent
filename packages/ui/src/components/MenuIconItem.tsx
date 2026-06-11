import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── MenuIconItem ─────────────────────────────────────────────────────────────
//
// Large settings-menu entry card (ported from AIRI's icon-item.vue):
// title + description on the left, oversized half-faded icon bleeding off
// the right edge. Hover: primary border, primary text, icon scales up and
// tints, a gradient light-sweep fades in from the left over a dotted
// texture. Dark-theme only (the app is fixed dark).

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
        'rounded-lg p-5 text-left cursor-pointer',
        'bg-neutral-900 border-2 border-solid border-neutral-800/25',
        'hover:border-primary-400/30',
        'transition-all duration-400 ease-in-out',
        // Light sweep (::before) — gradient swept in from the left on hover
        'before:content-empty before:absolute before:inset-0 before:z-0',
        'before:w-1/4 before:h-full before:opacity-0',
        'before:transition-all before:duration-400 before:ease-in-out',
        'before:[mask-image:linear-gradient(120deg,white_30%,transparent_50%)]',
        'hover:before:opacity-100 hover:before:w-[85%]',
        'hover:before:bg-gradient-to-r hover:before:from-primary-400/20 hover:before:via-primary-400/10 hover:before:to-transparent',
        // Dotted texture (::after) — faint dot grid fading toward bottom-right
        'after:content-empty after:absolute after:inset-0 after:z-0 after:w-full after:h-full',
        'after:[background-image:radial-gradient(circle,rgba(115,115,115,0.25)_1px,transparent_1px)]',
        'after:[background-size:10px_10px]',
        'after:[mask-image:linear-gradient(165deg,white_30%,transparent_50%)]',
        'after:transition-all after:duration-400',
        className,
      )}
      {...rest}
    >
      <div className="relative z-1 flex-1 min-w-0">
        <div className="text-lg font-normal text-neutral-100 group-hover:text-primary-300 transition-all duration-400 ease-in-out">
          {title}
        </div>
        <div className="text-sm text-neutral-400 group-hover:text-primary-300/80 transition-all duration-400 ease-in-out">
          {description}
        </div>
      </div>
      <div
        aria-hidden
        className={cn(
          icon,
          'absolute right-0 size-24 translate-y-4 opacity-50',
          'text-neutral-600/50 group-hover:text-primary-400 group-hover:scale-120',
          'transition-all duration-400 ease-in-out',
        )}
      />
    </button>
  );
}
