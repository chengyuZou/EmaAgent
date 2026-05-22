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
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-pill border border-transparent',
        'transition-ema focus-ring',
        'data-[state=unchecked]:bg-neutral-700/70',
        'data-[state=checked]:bg-primary-400/75',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block h-4 w-4 rounded-full bg-white shadow-md',
          'transition-transform duration-150 will-change-transform',
          'data-[state=unchecked]:translate-x-0.5',
          'data-[state=checked]:translate-x-[18px]',
        )}
      />
    </RadixSwitch.Root>
  );

  if (showLabel && label) {
    return (
      <label className="inline-flex items-center gap-2 cursor-pointer">
        {switchEl}
        <span className="text-sm text-neutral-200 select-none">{label}</span>
      </label>
    );
  }
  return switchEl;
}
