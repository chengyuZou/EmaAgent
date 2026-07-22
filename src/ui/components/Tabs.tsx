// 提供不会为未知值或空集合伪造激活项的选项卡组件。
import * as RadixTabs from '@radix-ui/react-tabs';
import type { ReactNode, CSSProperties } from 'react';
import { cn } from '../utils/cn.js';

// ── Tabs ────────────────────────────────────────────────────────────────────
//
// Horizontal or vertical Tabs. Mostly a thin Radix wrap with styled triggers
// and content panes.
//
// horizontal underline/pill 用滑动指示器(抄 AIRI select-tab):List ::before 滑块
// 按 --tab-active-index/--tab-count calc 平滑滑动,trigger 等宽(flex-1)。
// vertical sidebar 保留各自 active bg(无横向滑块)。

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
  /** Render only the trigger row; caller renders the active content itself
   *  (e.g. inside its own scroll container). Avoids double-rendering. */
  triggersOnly?: boolean;
  className?:    string;
}

export function Tabs(props: TabsProps): React.JSX.Element {
  const {
    value, onChange, items,
    orientation = 'horizontal',
    variant     = orientation === 'vertical' ? 'sidebar' : 'underline',
    triggersOnly = false,
    className,
  } = props;

  // 滑动指示器:当前选中 trigger 的 index(驱动 ::before calc)
  const activeIndex = items.findIndex((it) => it.value === value);
  const hasSlider = orientation === 'horizontal' && activeIndex >= 0 && items.length > 0;

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
        style={
          hasSlider
            ? ({ '--tab-active-index': activeIndex, '--tab-count': items.length } as CSSProperties)
            : undefined
        }
        className={cn(
          'flex',
          orientation === 'vertical' ? 'flex-col gap-1 min-w-44 shrink-0' : 'flex-row',
          variant === 'underline' && orientation === 'horizontal' && 'border-b border-[var(--ema-border)]',
          hasSlider && variant === 'underline' && 'ema-tab-slider ema-tab-slider--underline',
          hasSlider && variant === 'pill' && 'ema-tab-slider ema-tab-slider--pill',
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
              'text-[var(--ema-text-tertiary)] hover:text-[var(--ema-text-primary)]',
              // horizontal: 等宽 + 居中,让滑块 calc(100%/count * index) 定位准确
              orientation === 'horizontal' && 'flex-1 justify-center text-center',
              variant === 'underline' && cn(
                'data-[state=active]:text-[var(--ema-primary-text)]',
                // 滑块(ema-tab-slider--underline::before)代替 active border-b
              ),
              variant === 'pill' && cn(
                'relative z-1',
                'data-[state=active]:text-[var(--ema-primary-text)]',
                // 滑块(ema-tab-slider--pill::before)代替 active bg
              ),
              variant === 'sidebar' && cn(
                'rounded-md justify-start text-left w-full',
                'data-[state=active]:bg-[var(--ema-primary-muted)]/60',
                'data-[state=active]:text-[var(--ema-primary-text)]',
              ),
            )}
          >
            {it.icon && <span className={cn(it.icon, 'text-base')} aria-hidden />}
            {it.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {!triggersOnly && (
        <div className="flex-1 min-w-0">
          {items.map((it) => (
            <RadixTabs.Content
              key={it.value}
              value={it.value}
              className="outline-none ema-anim-tab"
            >
              {it.content}
            </RadixTabs.Content>
          ))}
        </div>
      )}
    </RadixTabs.Root>
  );
}
