import * as RadixTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Tabs ────────────────────────────────────────────────────────────────────
//
// Horizontal or vertical Tabs. Mostly a thin Radix wrap with styled triggers
// and content panes.

export interface TabItem {
  value:    string;
  label:    string;
  /** Optional UnoCSS icon class. */
  icon?:    string;
  content:  ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  value:         string;
  onChange:      (value: string) => void;
  items:         TabItem[];
  orientation?:  'horizontal' | 'vertical';
  /** Use small vertical sidebar style (e.g. for the settings panel). */
  variant?:      'underline' | 'pill' | 'sidebar';
  className?:    string;
}

export function Tabs(props: TabsProps): React.JSX.Element {
  const {
    value, onChange, items,
    orientation = 'horizontal',
    variant     = orientation === 'vertical' ? 'sidebar' : 'underline',
    className,
  } = props;

  return (
    <RadixTabs.Root
      value={value}
      onValueChange={onChange}
      orientation={orientation}
      className={cn(
        orientation === 'vertical' ? 'flex flex-row gap-4' : 'flex flex-col gap-3',
        className,
      )}
    >
      <RadixTabs.List
        className={cn(
          'flex',
          orientation === 'vertical' ? 'flex-col gap-1 min-w-44 shrink-0' : 'flex-row gap-1',
          variant === 'underline' && orientation === 'horizontal' && 'border-b border-neutral-700/40',
        )}
      >
        {items.map((it) => (
          <RadixTabs.Trigger
            key={it.value}
            value={it.value}
            disabled={it.disabled}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-ema cursor-pointer',
              'disabled:opacity-40 disabled:cursor-not-allowed',
              'text-neutral-400 hover:text-neutral-100',
              variant === 'underline' && cn(
                'border-b-2 border-transparent -mb-px',
                'data-[state=active]:text-primary-100',
                'data-[state=active]:border-primary-300',
              ),
              variant === 'pill' && cn(
                'rounded-pill',
                'data-[state=active]:bg-primary-500/25',
                'data-[state=active]:text-primary-100',
              ),
              variant === 'sidebar' && cn(
                'rounded-md justify-start text-left w-full',
                'data-[state=active]:bg-primary-500/15',
                'data-[state=active]:text-primary-100',
              ),
            )}
          >
            {it.icon && <span className={cn(it.icon, 'text-base')} aria-hidden />}
            {it.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      <div className="flex-1 min-w-0">
        {items.map((it) => (
          <RadixTabs.Content
            key={it.value}
            value={it.value}
            className="outline-none data-[state=inactive]:hidden"
          >
            {it.content}
          </RadixTabs.Content>
        ))}
      </div>
    </RadixTabs.Root>
  );
}
