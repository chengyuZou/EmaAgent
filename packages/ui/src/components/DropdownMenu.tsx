import * as RadixDropdown from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── DropdownMenu ────────────────────────────────────────────────────────────
//
// Click-triggered menu. Used by the chat mode picker (with submenu for Agent
// plan/debug/full), chat history actions (copy/delete), etc.
//
// Item types:
//   { kind: 'item', label, icon?, danger?, disabled?, onSelect, shortcut? }
//   { kind: 'separator' }
//   { kind: 'submenu', label, icon?, items: MenuItem[] }
//   { kind: 'checkbox', label, checked, onCheckedChange }

export type MenuItem =
  | { kind: 'item';      label: string; icon?: string; danger?: boolean; disabled?: boolean; shortcut?: string; onSelect(): void }
  | { kind: 'separator' }
  | { kind: 'submenu';   label: string; icon?: string; items: MenuItem[] }
  | { kind: 'checkbox';  label: string; icon?: string; checked: boolean; onCheckedChange(v: boolean): void };

export interface DropdownMenuProps {
  trigger:   ReactNode;
  items:     MenuItem[];
  side?:     'top' | 'right' | 'bottom' | 'left';
  align?:    'start' | 'center' | 'end';
  widthClass?: string;
}

export function DropdownMenu(props: DropdownMenuProps): React.JSX.Element {
  const { trigger, items, side = 'bottom', align = 'start', widthClass = 'min-w-48' } = props;
  return (
    <RadixDropdown.Root>
      <RadixDropdown.Trigger asChild>{trigger}</RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            'z-40 panel-glass rounded-lg p-1 shadow-xl',
            widthClass,
            'ema-anim-scale',
          )}
        >
          {items.map((it, i) => <RenderItem key={i} item={it} />)}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}

function RenderItem({ item }: { item: MenuItem }): React.JSX.Element {
  switch (item.kind) {
    case 'separator':
      return <RadixDropdown.Separator className="my-1 h-px bg-neutral-700/40" />;

    case 'item':
      return (
        <RadixDropdown.Item
          disabled={item.disabled}
          onSelect={item.onSelect}
          className={cn(itemBaseCn, item.danger ? itemDangerCn : '')}
        >
          {item.icon && <span className={cn(item.icon, 'text-base')} aria-hidden />}
          <span className="flex-1">{item.label}</span>
          {item.shortcut && <span className="ml-2 text-xs text-neutral-500">{item.shortcut}</span>}
        </RadixDropdown.Item>
      );

    case 'checkbox':
      return (
        <RadixDropdown.CheckboxItem
          checked={item.checked}
          onCheckedChange={item.onCheckedChange}
          className={itemBaseCn}
        >
          <span className="w-4 inline-flex items-center justify-center">
            <RadixDropdown.ItemIndicator>
              <span className="i-mdi:check text-sm" aria-hidden />
            </RadixDropdown.ItemIndicator>
          </span>
          {item.icon && <span className={cn(item.icon, 'text-base')} aria-hidden />}
          <span className="flex-1">{item.label}</span>
        </RadixDropdown.CheckboxItem>
      );

    case 'submenu':
      return (
        <RadixDropdown.Sub>
          <RadixDropdown.SubTrigger className={itemBaseCn}>
            {item.icon && <span className={cn(item.icon, 'text-base')} aria-hidden />}
            <span className="flex-1">{item.label}</span>
            <span className="i-mdi:chevron-right text-base" aria-hidden />
          </RadixDropdown.SubTrigger>
          <RadixDropdown.Portal>
            <RadixDropdown.SubContent
              className={cn(
                'z-50 panel-glass rounded-lg p-1 shadow-xl min-w-44',
                'ema-anim-scale',
              )}
            >
              {item.items.map((sub, i) => <RenderItem key={i} item={sub} />)}
            </RadixDropdown.SubContent>
          </RadixDropdown.Portal>
        </RadixDropdown.Sub>
      );
  }
}

const itemBaseCn =
  'flex items-center gap-2 px-2.5 py-1.5 rounded-sm text-sm cursor-pointer ' +
  'outline-none transition-ema ' +
  'data-[highlighted]:bg-primary-500/20 data-[highlighted]:text-primary-100 ' +
  'data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed';

const itemDangerCn =
  'data-[highlighted]:bg-red-500/30 data-[highlighted]:text-white text-red-200';
