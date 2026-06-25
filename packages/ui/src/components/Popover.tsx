import * as RadixPopover from '@radix-ui/react-popover';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Popover ─────────────────────────────────────────────────────────────────
//
// Click-triggered floating panel. Used for:
//   - Session switcher (chat top bar)
//   - Model picker (chat bottom bar)
//   - Context window breakdown
//   - Mode picker (input toolbar)

export interface PopoverProps {
  /** Trigger element. The trigger ref forwarding is handled by Radix. */
  trigger:     ReactNode;
  /** Popover body. */
  children:    ReactNode;
  /** Default open state for uncontrolled use. */
  defaultOpen?: boolean;
  open?:       boolean;
  onOpenChange?: (open: boolean) => void;
  side?:       'top' | 'right' | 'bottom' | 'left';
  align?:      'start' | 'center' | 'end';
  sideOffset?: number;
  /** Width of the popover. CSS class string (e.g. 'w-72'). Must be a static string for UnoCSS scanning. */
  widthClass?: string;
  /** Inline style — use for dynamic widths (e.g. `{ width: 280 }`) to avoid UnoCSS scanning limits. */
  style?:      CSSProperties;
  className?:  string;
}

export function Popover(props: PopoverProps): React.JSX.Element {
  const {
    trigger, children,
    defaultOpen, open, onOpenChange,
    side       = 'bottom',
    align      = 'center',
    sideOffset = 8,
    widthClass = 'w-64',
    style,
    className,
  } = props;

  return (
    <RadixPopover.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          style={style}
          className={cn(
            'z-40 panel-glass rounded-lg p-2 shadow-xl',
            widthClass,
            'ema-anim-scale',
            'focus:outline-none',
            className,
          )}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
