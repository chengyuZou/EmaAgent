import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

export function TooltipProvider({
  delayDuration = 200,
  ...props
}: RadixTooltip.TooltipProviderProps): React.JSX.Element {
  return <RadixTooltip.Provider delayDuration={delayDuration} {...props} />;
}

export interface TooltipProps {
  /** undefined, null 或空字符串时不显示提示, 子元素保持原样. */
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  /** 不传时使用最近的 TooltipProvider 设置, 单位为毫秒. */
  delayDuration?: number;
  variant?: 'label' | 'card';
  className?: string;
  disabled?: boolean;
}

export function Tooltip(props: TooltipProps): React.JSX.Element {
  const {
    content,
    children,
    side = 'top',
    align = 'center',
    sideOffset = 6,
    delayDuration,
    variant = 'label',
    className,
    disabled,
  } = props;

  if (disabled || content == null || content === '') {
    return <>{children}</>;
  }

  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={12}
          className={cn(
            'ema-tooltip-surface ema-anim-fade',
            variant === 'card' ? 'ema-tooltip-card' : 'ema-tooltip-label',
            className,
          )}
        >
          {content}
          {variant === 'label' && <RadixTooltip.Arrow className="ema-tooltip-arrow" />}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
