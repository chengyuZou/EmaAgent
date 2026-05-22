import * as RadixScrollArea from '@radix-ui/react-scroll-area';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── ScrollArea ──────────────────────────────────────────────────────────────
//
// Custom-styled scrollbar (thinner, only visible on hover). Use anywhere the
// native scrollbar would clash with the app's dark / glass aesthetic
// (session list, message history, settings sections).

export interface ScrollAreaProps {
  /** 'vertical' (default), 'horizontal', or 'both'. */
  orientation?: 'vertical' | 'horizontal' | 'both';
  /** Always-visible scrollbar vs hover-only. Default 'hover'. */
  scrollbar?:   'always' | 'hover' | 'never';
  children:     ReactNode;
  className?:   string;
  /** Class applied to the scrollable viewport. */
  viewportClassName?: string;
}

export function ScrollArea(props: ScrollAreaProps): React.JSX.Element {
  const {
    orientation = 'vertical',
    scrollbar   = 'hover',
    children, className, viewportClassName,
  } = props;

  const showVertical   = orientation === 'vertical'   || orientation === 'both';
  const showHorizontal = orientation === 'horizontal' || orientation === 'both';

  return (
    <RadixScrollArea.Root
      type={scrollbar === 'never' ? 'auto' : scrollbar}
      className={cn('relative overflow-hidden', className)}
    >
      <RadixScrollArea.Viewport className={cn('h-full w-full rounded-[inherit]', viewportClassName)}>
        {children}
      </RadixScrollArea.Viewport>

      {showVertical && scrollbar !== 'never' && (
        <RadixScrollArea.Scrollbar
          orientation="vertical"
          className={cn(
            'flex touch-none select-none p-0.5 transition-colors',
            'w-2 hover:w-2.5',
            'bg-transparent hover:bg-neutral-800/30',
          )}
        >
          <RadixScrollArea.Thumb className="relative flex-1 rounded-pill bg-neutral-500/60 hover:bg-neutral-400/80" />
        </RadixScrollArea.Scrollbar>
      )}

      {showHorizontal && scrollbar !== 'never' && (
        <RadixScrollArea.Scrollbar
          orientation="horizontal"
          className={cn(
            'flex touch-none select-none p-0.5 transition-colors',
            'h-2 hover:h-2.5',
            'bg-transparent hover:bg-neutral-800/30',
          )}
        >
          <RadixScrollArea.Thumb className="relative flex-1 rounded-pill bg-neutral-500/60 hover:bg-neutral-400/80" />
        </RadixScrollArea.Scrollbar>
      )}

      <RadixScrollArea.Corner className="bg-transparent" />
    </RadixScrollArea.Root>
  );
}
