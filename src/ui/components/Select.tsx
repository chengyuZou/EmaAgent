// 提供可由 Field 注入无障碍关联信息的单选下拉组件。
import * as RadixSelect from '@radix-ui/react-select';
import type { AriaAttributes, ReactNode } from 'react';
import { cn } from '../utils/cn.js';
import { overlayItemCn } from './overlayItem.js';

// ── Select ──────────────────────────────────────────────────────────────────
// 单选下拉, 用于表单字段(供应商选择/简单模型绑定); 临时菜单请用 <DropdownMenu/>.

export interface SelectOption {
  value:     string;
  label:     string;
  icon?:     string;
  disabled?: boolean;
  /** 在该项上方画一条分组发丝线(如"系统默认"与本机清单之间). */
  separatorAbove?: boolean;
}

export interface SelectProps extends Pick<
  AriaAttributes,
  'aria-describedby' | 'aria-errormessage' | 'aria-invalid' | 'aria-required' | 'aria-label'
> {
  id?:           string;
  value?:        string;
  onChange:      (value: string) => void;
  options:       SelectOption[];
  placeholder?:  string;
  disabled?:     boolean;
  /** 应用到 trigger 元素上的样式类。 */
  className?:    string;
  /** Trigger element override (e.g. ghost-styled in tight UIs). */
  trigger?:      ReactNode;
  /** UnoCSS icon class for the trigger chevron. Defaults to "i-mdi:chevron-down". */
  chevronIcon?:  string;
  /** UnoCSS icon class for the selected-item checkmark. Defaults to "i-mdi:check". */
  checkIcon?:    string;
}

export function Select(props: SelectProps): React.JSX.Element {
  const {
    value,
    onChange,
    options,
    placeholder = '请选择…',
    disabled,
    className,
    trigger,
    chevronIcon,
    checkIcon,
    id,
    ...accessibilityProps
  } = props;

  return (
    <RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RadixSelect.Trigger
        id={id}
        {...accessibilityProps}
        className={cn(
          'inline-flex items-center justify-between gap-2 w-full',
          'h-9 px-3 text-sm rounded-xl border text-[var(--ema-text-primary)]',
          'bg-[var(--ema-control-bg)] shadow-[var(--ema-control-shadow)]',
          'hover:bg-[var(--ema-control-bg-hover)] data-[state=open]:bg-[var(--ema-control-bg-focus)]',
          'border-[var(--ema-control-border)] hover:border-[var(--ema-control-border-hover)]',
          'data-[state=open]:border-[var(--ema-control-border-focus)] data-[state=open]:shadow-[var(--ema-control-shadow-focus)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'focus-visible:border-[var(--ema-control-border-focus)] focus-visible:shadow-[var(--ema-control-shadow-focus)] transition-ema',
          className,
        )}
      >
        {trigger ?? (
          <RadixSelect.Value placeholder={<span className="text-[var(--ema-text-tertiary)]">{placeholder}</span>} />
        )}
        <RadixSelect.Icon className="text-[var(--ema-text-tertiary)]">
          <span className={cn(chevronIcon ?? 'i-mdi:chevron-down', 'text-base')} aria-hidden />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-[var(--ema-z-overlay)] panel-glass rounded-xl shadow-[var(--ema-shadow-2)]',
            'min-w-[var(--radix-select-trigger-width)]',
            'ema-anim-expand',
          )}
        >
          {/* 展开动画的 grid 子节点: 裁剪与滑动都作用在这层, Viewport 保留自身滚动 */}
          <div className="p-1">
            <RadixSelect.Viewport className="ema-select-viewport max-h-72 overflow-y-auto">
              {options.map((opt) => (
                <RadixSelect.Item
                  key={opt.value}
                  value={opt.value}
                  disabled={opt.disabled}
                  className={cn(
                    overlayItemCn,
                    'data-[state=checked]:text-[var(--ema-primary-text)]',
                    opt.separatorAbove && 'mt-1 border-t border-[var(--ema-border)] pt-1',
                  )}
                >
                  {opt.icon && <span className={cn(opt.icon, 'text-base')} aria-hidden />}
                  <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="ml-auto">
                    <span className={cn(checkIcon ?? 'i-mdi:check', 'text-sm ema-check-pop')} aria-hidden />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </div>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
