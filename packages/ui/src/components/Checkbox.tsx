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
  className?:      string;
}

export function Checkbox(props: CheckboxProps): React.JSX.Element {
  const { checked, defaultChecked, onCheckedChange, disabled, label, showLabel, className } = props;

  const box = (
    <RadixCheckbox.Root
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-ema',
        'border-neutral-600 bg-neutral-800/60',
        'data-[state=checked]:border-primary-400 data-[state=checked]:bg-primary-500/30',
        'data-[state=indeterminate]:border-primary-400 data-[state=indeterminate]:bg-primary-500/20',
        'hover:border-primary-300',
        'focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <RadixCheckbox.Indicator className="flex items-center justify-center text-primary-200">
        {checked === 'indeterminate'
          ? <span className="i-mdi:minus text-xs" aria-hidden />
          : <span className="i-mdi:check text-xs" aria-hidden />}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );

  if (showLabel && label) {
    return (
      <label className="inline-flex items-center gap-2 cursor-pointer select-none">
        {box}
        <span className="text-sm text-neutral-200">{label}</span>
      </label>
    );
  }
  return box;
}
