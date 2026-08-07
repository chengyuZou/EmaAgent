import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Tooltip ─────────────────────────────────────────────────────────────────
//
// 悬停/聚焦触发的文字标签,包裹任意可聚焦元素;仅单行文本,
// 更丰富的内容请用 <Popover/>。应用根部需挂载 <TooltipProvider>。

export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  content:    ReactNode;
  children:   ReactNode;
  side?:      'top' | 'right' | 'bottom' | 'left';
  align?:     'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
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
            'z-50 rounded-md border border-[var(--ema-border)] bg-[var(--ema-surface-4)] px-2.5 py-1',
            'text-xs text-[var(--ema-text-primary)] shadow-[var(--ema-shadow-2)]',
            'ema-anim-fade',
          )}
        >
          {content}
          <RadixTooltip.Arrow className="fill-[var(--ema-surface-4)]" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
