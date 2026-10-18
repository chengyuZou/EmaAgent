import * as RadixPopover from '@radix-ui/react-popover';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../utils/cn.js';
import { Tooltip } from './Tooltip.js';

export interface PopoverProps {
  /** Trigger element. The trigger ref forwarding is handled by Radix. */
  trigger:     ReactNode;
  /** 触发按钮的只读悬停提示, 不改变面板的点击或焦点行为. */
  triggerTooltip?: ReactNode;
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
  /** Inline style - use for dynamic widths (e.g. `{ width: 280 }`) to avoid UnoCSS scanning limits. */
  style?:      CSSProperties;
  className?:  string;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export function Popover(props: PopoverProps): React.JSX.Element {
  const {
    trigger,
    triggerTooltip,
    children,
    defaultOpen,
    open,
    onOpenChange,
    side       = 'bottom',
    align      = 'center',
    sideOffset = 8,
    widthClass = 'w-64',
    style,
    className,
    onOpenAutoFocus,
    onCloseAutoFocus,
  } = props;

  return (
    <RadixPopover.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <Tooltip content={triggerTooltip} side={side}>
        <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      </Tooltip>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          style={style}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            'z-[var(--ema-z-overlay)] panel-glass rounded-xl shadow-[var(--ema-shadow-2)]',
            widthClass,
            'ema-anim-expand',
            'focus:outline-none',
            className,
          )}
        >
          {/* 展开动画的 grid 子节点: 裁剪与滑动都作用在这层, padding 也移到这里(否则收起时留 16px 残边) */}
          <div className="p-2">
            {children}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
