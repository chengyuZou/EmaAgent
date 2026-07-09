import * as RadixSlider from '@radix-ui/react-slider';
import { cn } from '../utils/cn.js';

// ── Slider ──────────────────────────────────────────────────────────────────
//
// Discrete-step slider for things like LLM "Effort" (Low / Medium / High / Max).
// `steps` defines all valid stops + their visible labels. We render the
// labels under the track.

export interface SliderStep<T = number> {
  value: T;
  label: string;
}

export interface SliderProps<T = number> {
  value:         T;
  onChange:      (value: T) => void;
  steps:         SliderStep<T>[];
  disabled?:     boolean;
  /** Hide the labels row. Default false. */
  hideLabels?:   boolean;
  className?:    string;
}

export function Slider<T extends string | number>(props: SliderProps<T>): React.JSX.Element {
  const { value, onChange, steps, disabled, hideLabels, className } = props;

  const currentIndex = Math.max(0, steps.findIndex((s) => s.value === value));
  const max = Math.max(0, steps.length - 1);

  return (
    <div className={cn('w-full', className)}>
      <RadixSlider.Root
        value={[currentIndex]}
        onValueChange={(v) => {
          const idx = v[0] ?? 0;
          const next = steps[idx];
          if (next) onChange(next.value);
        }}
        min={0}
        max={max}
        step={1}
        disabled={disabled}
        className={cn(
          'relative flex h-5 w-full touch-none select-none items-center',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <RadixSlider.Track className="relative h-1.5 grow rounded-pill bg-[var(--ema-surface-3)]">
          <RadixSlider.Range className="absolute h-full rounded-pill bg-[var(--ema-primary)]" />
        </RadixSlider.Track>
        <RadixSlider.Thumb
          className={cn(
            'block h-4 w-4 rounded-full bg-white border border-[var(--ema-primary)]/60',
            'shadow-md focus-ring',
            'transition-ema hover:scale-110',
          )}
          aria-label="value"
        />
      </RadixSlider.Root>

      {!hideLabels && (
        <div className="mt-2 flex justify-between text-xs text-[var(--ema-text-tertiary)]">
          {steps.map((s, i) => (
            <span
              key={i}
              className={cn(
                'cursor-pointer transition-ema',
                i === currentIndex ? 'text-[var(--ema-primary-text)] font-medium' : 'hover:text-[var(--ema-text-primary)]',
              )}
              onClick={() => !disabled && onChange(s.value)}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
