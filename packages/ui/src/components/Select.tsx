import * as RadixSelect from '@radix-ui/react-select';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Select ──────────────────────────────────────────────────────────────────
//
// Single-select dropdown. Use for form fields (provider picker, model picker
// when it's a simple binding edit). For ad-hoc menus use <DropdownMenu/>.

export interface SelectOption {
  value:     string;
  label:     string;
  icon?:     string;
  disabled?: boolean;
}

export interface SelectProps {
  value?:        string;
  onChange:      (value: string) => void;
  options:       SelectOption[];
  placeholder?:  string;
  disabled?:     boolean;
  /** Show below the trigger; full popover width. */
  className?:    string;
  /** Trigger element override (e.g. ghost-styled in tight UIs). */
  trigger?:      ReactNode;
}

export function Select(props: SelectProps): React.JSX.Element {
  const { value, onChange, options, placeholder = '请选择…', disabled, className, trigger } = props;

  return (
    <RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RadixSelect.Trigger
        className={cn(
          'inline-flex items-center justify-between gap-2 w-full',
          'h-9 px-3 text-sm rounded-md border bg-neutral-900/60 text-neutral-100',
          'border-neutral-700/50 hover:border-neutral-600',
          'data-[state=open]:border-primary-300',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'focus-ring transition-ema',
          className,
        )}
      >
        {trigger ?? (
          <RadixSelect.Value placeholder={<span className="text-neutral-500">{placeholder}</span>} />
        )}
        <RadixSelect.Icon className="text-neutral-400">
          <span className="i-mdi:chevron-down text-base" aria-hidden />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-50 panel-glass rounded-lg p-1 shadow-xl',
            'min-w-[var(--radix-select-trigger-width)]',
            'data-[state=open]:animate-fade-in',
          )}
        >
          <RadixSelect.Viewport className="max-h-72">
            {options.map((opt) => (
              <RadixSelect.Item
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                className={cn(
                  'flex items-center gap-2 px-2.5 py-1.5 rounded-sm text-sm cursor-pointer',
                  'outline-none transition-ema',
                  'data-[highlighted]:bg-primary-500/20 data-[highlighted]:text-primary-100',
                  'data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed',
                  'data-[state=checked]:text-primary-100',
                )}
              >
                {opt.icon && <span className={cn(opt.icon, 'text-base')} aria-hidden />}
                <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="ml-auto">
                  <span className="i-mdi:check text-sm" aria-hidden />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
