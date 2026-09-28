import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Tooltip ─────────────────────────────────────────────────────────────────
//
// 悬停/聚焦的只读提示: label 用于短标签, card 用于用量或文本预览.
// 含交互操作的内容使用 Popover. 应用根部需挂载 TooltipProvider.

export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  content:    ReactNode;
  children:   ReactNode;
  side?:      'top' | 'right' | 'bottom' | 'left';
  align?:     'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  variant?: 'label' | 'card';
  className?: string;
  /** Disable so consumer can conditionally suppress. */
  disabled?:  boolean;
}

export function Tooltip(props: TooltipProps): React.JSX.Element {
  const {
    content, children,
    side       = 'top',
    align      = 'center',
    sideOffset = 6,
    delayDuration = 200,
    variant = 'label',
    className,
    disabled,
  } = props;

  if (disabled) return <>{children}</>;

  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          className={cn(
            'z-[var(--ema-z-tooltip)] text-xs shadow-[var(--ema-shadow-2)]',
            variant === 'card'
              ? 'ema-tooltip-card'
              : 'rounded-md bg-[var(--ema-text-primary)] px-2.5 py-1 font-medium text-[var(--ema-bg)]',
            'ema-tooltip-surface ema-anim-fade',
            className,
          )}
        >
          {content}
          {variant === 'label' && <RadixTooltip.Arrow className="ema-tooltip-arrow fill-[var(--ema-text-primary)]" />}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
