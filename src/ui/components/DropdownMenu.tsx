import * as RadixDropdown from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';
import { overlayItemCn, overlayItemDangerCn } from './overlayItem.js';

// ── DropdownMenu ────────────────────────────────────────────────────────────
//
// 点击触发的菜单(聊天模式切换, 历史操作等).
// 条目类型: item / separator / submenu(递归) / checkbox.

export type MenuItem =
  | { kind: 'item';      id?: string; label: string; icon?: string; danger?: boolean; disabled?: boolean; shortcut?: string; description?: string; onSelect(): void }
  | { kind: 'separator' }
  | { kind: 'submenu';   id?: string; label: string; icon?: string; items: MenuItem[] | (() => MenuItem[]) }
  | { kind: 'checkbox';  id?: string; label: string; icon?: string; checked: boolean; onCheckedChange(v: boolean): void };

export interface DropdownMenuProps {
  trigger:   ReactNode;
  /** 传函数时只在菜单真正展开后生成条目, 避免每次输入文字都重建模型等列表. */
  items:     MenuItem[] | (() => MenuItem[]);
  side?:     'top' | 'right' | 'bottom' | 'left';
  align?:    'start' | 'center' | 'end';
  widthClass?: string;
  /** UnoCSS icon class for a checked checkbox item. Defaults to "i-mdi:check". */
  checkIcon?:  string;
  /** UnoCSS icon class for a submenu arrow. Defaults to "i-mdi:chevron-right". */
  submenuIcon?: string;
}

export function DropdownMenu(props: DropdownMenuProps): React.JSX.Element {
  const { trigger, items, side = 'bottom', align = 'start', widthClass = 'min-w-48', checkIcon, submenuIcon } = props;
  return (
    <RadixDropdown.Root>
      <RadixDropdown.Trigger asChild>{trigger}</RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            'z-[var(--ema-z-overlay)] panel-glass rounded-xl shadow-[var(--ema-shadow-2)]',
            widthClass,
            'ema-anim-expand',
          )}
        >
          {/* 展开动画的 grid 子节点: 裁剪与滑动都作用在这层 */}
          <div className="p-1">
            <MenuItems items={items} checkIcon={checkIcon} submenuIcon={submenuIcon} />
          </div>
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}

function MenuItems({ items, checkIcon, submenuIcon }: {
  items: MenuItem[] | (() => MenuItem[]);
  checkIcon?: string;
  submenuIcon?: string;
}): React.JSX.Element {
  const resolved = typeof items === 'function' ? items() : items;
  return <>{resolved.map((item, index) => (
    <RenderItem
      key={item.kind === 'separator' ? `separator:${index}` : item.id ?? `${item.kind}:${item.label}`}
      item={item}
      checkIcon={checkIcon}
      submenuIcon={submenuIcon}
    />
  ))}</>;
}

function RenderItem({ item, checkIcon, submenuIcon }: { item: MenuItem; checkIcon?: string; submenuIcon?: string }): React.JSX.Element {
  switch (item.kind) {
    case 'separator':
      return <RadixDropdown.Separator className="my-1 h-px bg-[var(--ema-border)]" />;

    case 'item':
      return (
        <RadixDropdown.Item
          disabled={item.disabled}
          onSelect={item.onSelect}
          className={cn(overlayItemCn, item.danger ? overlayItemDangerCn : '')}
        >
          {item.icon && <span className={cn(item.icon, 'text-base')} aria-hidden />}
          <span className="flex-1">
            <span className="block">{item.label}</span>
            {item.description && (
              <span className="block text-[11px] leading-snug text-[var(--ema-text-tertiary)]">
                {item.description}
              </span>
            )}
          </span>
          {item.shortcut && <span className="ml-2 text-xs text-[var(--ema-text-tertiary)]">{item.shortcut}</span>}
        </RadixDropdown.Item>
      );

    case 'checkbox':
      return (
        <RadixDropdown.CheckboxItem
          checked={item.checked}
          onCheckedChange={item.onCheckedChange}
          className={overlayItemCn}
        >
          <span className="w-4 inline-flex items-center justify-center">
            <RadixDropdown.ItemIndicator>
              <span className={cn(checkIcon ?? 'i-mdi:check', 'text-sm ema-check-pop')} aria-hidden />
            </RadixDropdown.ItemIndicator>
          </span>
          {item.icon && <span className={cn(item.icon, 'text-base')} aria-hidden />}
          <span className="flex-1">{item.label}</span>
        </RadixDropdown.CheckboxItem>
      );

    case 'submenu':
      return (
        <RadixDropdown.Sub>
          <RadixDropdown.SubTrigger className={overlayItemCn}>
            {item.icon && <span className={cn(item.icon, 'text-base')} aria-hidden />}
            <span className="flex-1">{item.label}</span>
            <span className={cn(submenuIcon ?? 'i-mdi:chevron-right', 'text-base')} aria-hidden />
          </RadixDropdown.SubTrigger>
          <RadixDropdown.Portal>
            <RadixDropdown.SubContent
              className={cn(
                'z-[var(--ema-z-overlay)] panel-glass rounded-xl shadow-[var(--ema-shadow-2)] min-w-44',
                'ema-anim-expand',
              )}
            >
              <div className="p-1">
                <MenuItems items={item.items} checkIcon={checkIcon} submenuIcon={submenuIcon} />
              </div>
            </RadixDropdown.SubContent>
          </RadixDropdown.Portal>
        </RadixDropdown.Sub>
      );
  }
}
