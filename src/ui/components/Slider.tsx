// 提供能显式处理空步骤、未知值和非法数字步骤的离散滑块。
import * as RadixSlider from '@radix-ui/react-slider';
import { cn } from '../utils/cn.js';

// ── Slider ──────────────────────────────────────────────────────────────────
//
// 离散步进滑杆(如 LLM Effort 的 Low/Medium/High/Max);
// steps 定义全部有效档位及其标签,标签渲染在轨道下方。

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

  const validSteps = steps.filter((item) => (
    typeof item.value !== 'number' || Number.isFinite(item.value)
  ));
  const currentIndex = validSteps.findIndex((item) => item.value === value);
  const isEmpty = validSteps.length === 0;
  const max = Math.max(0, validSteps.length - 1);

  if (isEmpty) {
    return (
      <div
        className={cn('w-full h-5 opacity-50 cursor-not-allowed', className)}
        aria-disabled="true"
        data-empty="true"
      />
    );
  }

  return (
    <div className={cn('w-full', className)}>
      <RadixSlider.Root
        value={currentIndex >= 0 ? [currentIndex] : []}
        onValueChange={(v) => {
          const rawIndex = v[0];
          if (rawIndex === undefined || !Number.isFinite(rawIndex)) return;
          const index = Math.round(rawIndex);
          const next = validSteps[index];
          if (next) onChange(next.value);
        }}
        min={0}
        max={max}
        step={1}
        disabled={disabled}
        aria-disabled={disabled || undefined}
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
          {validSteps.map((s, i) => (
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
