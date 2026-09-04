import * as RadixSwitch from '@radix-ui/react-switch';
import { cn } from '../utils/cn.js';

// ── Switch ──────────────────────────────────────────────────────────────────

export interface SwitchProps {
  checked?:        boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?:       boolean;
  /** Accessible label; also used as visible label if `showLabel`. */
  label?:          string;
  showLabel?:      boolean;
  className?:      string;
}

export function Switch(props: SwitchProps): React.JSX.Element {
  const { checked, defaultChecked, onCheckedChange, disabled, label, showLabel, className } = props;

  const switchEl = (
    <RadixSwitch.Root
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        'relative inline-flex h-7 w-12.5 shrink-0 cursor-pointer items-center rounded-pill border shadow-inner',
        'transition-ema focus-ring hover:shadow-[var(--ema-shadow-soft)]',
        'data-[state=unchecked]:border-[var(--ema-border-hover)] data-[state=unchecked]:bg-[var(--ema-surface-3)]',
        'data-[state=unchecked]:hover:border-[var(--ema-text-tertiary)]',
        'data-[state=checked]:border-[var(--ema-primary)] data-[state=checked]:bg-[var(--ema-primary)]',
        'data-[state=checked]:hover:border-[var(--ema-primary-hover)] data-[state=checked]:hover:bg-[var(--ema-primary-hover)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block h-6 w-6 rounded-full border border-black/5 bg-white shadow-md',
          'translate-x-0.5 data-[state=checked]:translate-x-full',
          'transition-transform duration-250 ease-in-out will-change-transform',
          'data-[state=checked]:shadow-[0_2px_8px_rgba(0,0,0,0.24)]',
        )}
      />
    </RadixSwitch.Root>
  );

  if (showLabel && label) {
    return (
      <label className="inline-flex items-center gap-2 cursor-pointer">
        {switchEl}
        <span className="text-sm text-[var(--ema-text-primary)] select-none">{label}</span>
      </label>
    );
  }
  return switchEl;
}
