import { cn } from '../utils/cn.js';

// ── Progress ────────────────────────────────────────────────────────────────
//
// Horizontal progress bar with optional shine animation (copied from AIRI's
// progress.vue). Used for:
//   - Model download / load progress
//   - TTS synthesis batch progress
//   - Any indeterminate → determinate transition
//
// Shine animation triggers when progress < 100 and `animated` is true.

export interface ProgressProps {
  /** 0-100 percentage. */
  progress: number;
  /** Show the shimmer sweep while in progress. Default true. */
  animated?: boolean;
  /** Tailwind height class override (default 'h-4'). */
  height?:  string;
  /** Bar colour class override (default uses primary). */
  barClass?: string;
  className?: string;
}

export function Progress({
  progress,
  animated = true,
  height = 'h-4',
  barClass,
  className,
}: ProgressProps): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, progress));

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('relative overflow-hidden rounded-md w-full', height, className)}
    >
      {/* Track (background) */}
      <div className={cn('absolute inset-0 rounded-md bg-neutral-800', height)} />

      {/* Fill bar */}
      <div
        className={cn(
          'absolute left-0 top-0 rounded-md transition-[width] duration-500 ease-in-out will-change-[width]',
          height,
          barClass || 'bg-primary-400/80',
        )}
        style={{ width: `${clamped}%` }}
      >
        {/* Shine sweep (AIRI's progress-shine animation) */}
        {animated && clamped < 100 && (
          <div
            className="animate-progress-shine absolute inset-0 origin-left rounded-md bg-white/30"
            style={{ willChange: 'transform, opacity' }}
          />
        )}
      </div>
    </div>
  );
}
