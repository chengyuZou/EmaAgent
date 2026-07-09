import * as RadixCheckbox from '@radix-ui/react-checkbox';
import { cn } from '../utils/cn.js';

// ── Checkbox ────────────────────────────────────────────────────────────────
//
// Supports three states: unchecked / checked / indeterminate.
// `showLabel` wraps in a <label> for click-to-toggle on the text.

export interface CheckboxProps {
  checked?:        boolean | 'indeterminate';
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean | 'indeterminate') => void;
  disabled?:       boolean;
  /** Accessible label; visible text when `showLabel` is true. */
  label?:          string;
  showLabel?:      boolean;
  /** UnoCSS icon class for the checked state. Defaults to "i-mdi:check". */
  checkIcon?:         string;
  /** UnoCSS icon class for the indeterminate state. Defaults to "i-mdi:minus". */
  indeterminateIcon?: string;
  className?:      string;
}

export function Checkbox(props: CheckboxProps): React.JSX.Element {
  const { checked, defaultChecked, onCheckedChange, disabled, label, showLabel, checkIcon, indeterminateIcon, className } = props;

  const box = (
    <RadixCheckbox.Root
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-ema',
        'border-[var(--ema-border)] bg-[var(--ema-surface-2)]',
        'data-[state=checked]:border-[var(--ema-primary)] data-[state=checked]:bg-[var(--ema-primary-muted)]',
        'data-[state=indeterminate]:border-[var(--ema-primary)] data-[state=indeterminate]:bg-[var(--ema-primary-muted)]',
        'hover:border-[var(--ema-primary)]',
        'focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <RadixCheckbox.Indicator className="flex items-center justify-center text-[var(--ema-primary-text)]">
        {checked === 'indeterminate'
          ? <span className={cn(indeterminateIcon ?? 'i-mdi:minus', 'text-xs')} aria-hidden />
          : <span className={cn(checkIcon ?? 'i-mdi:check', 'text-xs')} aria-hidden />}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );

  if (showLabel && label) {
    return (
      <label className="inline-flex items-center gap-2 cursor-pointer select-none">
        {box}
        <span className="text-sm text-[var(--ema-text-primary)]">{label}</span>
      </label>
    );
  }
  return box;
}
