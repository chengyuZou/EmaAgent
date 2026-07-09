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
  /** UnoCSS icon class for the trigger chevron. Defaults to "i-mdi:chevron-down". */
  chevronIcon?:  string;
  /** UnoCSS icon class for the selected-item checkmark. Defaults to "i-mdi:check". */
  checkIcon?:    string;
}

export function Select(props: SelectProps): React.JSX.Element {
  const { value, onChange, options, placeholder = '请选择…', disabled, className, trigger, chevronIcon, checkIcon } = props;

  return (
    <RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RadixSelect.Trigger
        className={cn(
          'inline-flex items-center justify-between gap-2 w-full',
          'h-9 px-3 text-sm rounded-md border bg-[var(--ema-surface-2)] text-[var(--ema-text-primary)]',
          'border-[var(--ema-border)] hover:border-[var(--ema-border-hover)]',
          'data-[state=open]:border-[var(--ema-primary)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'focus-ring transition-ema',
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
            'z-50 panel-glass rounded-lg p-1 shadow-xl',
            'min-w-[var(--radix-select-trigger-width)]',
            'ema-anim-scale',
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
                  'data-[highlighted]:bg-[var(--ema-primary-muted)] data-[highlighted]:text-[var(--ema-primary-text)]',
                  'data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed',
                  'data-[state=checked]:text-[var(--ema-primary-text)]',
                )}
              >
                {opt.icon && <span className={cn(opt.icon, 'text-base')} aria-hidden />}
                <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="ml-auto">
                  <span className={cn(checkIcon ?? 'i-mdi:check', 'text-sm')} aria-hidden />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
