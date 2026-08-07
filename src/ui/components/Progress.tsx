// 显示经过有限数值归一化的确定型进度。
import { cn } from '../utils/cn.js';
import { clampFinite } from '../utils/number.js';

// ── Progress ────────────────────────────────────────────────────────────────
// 水平进度条,可选流光动画(progress < 100 且 animated=true 时触发)。
// 用于模型下载/加载、TTS 批量合成等进度展示。

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
  const clamped = clampFinite(progress, 0, 100);

  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('relative overflow-hidden rounded-md w-full', height, className)}
    >
      {/* Track (background) */}
      <div className={cn('absolute inset-0 rounded-md bg-[var(--ema-surface-2)]', height)} />

      {/* Fill bar */}
      <div
        className={cn(
          'absolute left-0 top-0 rounded-md transition-[width] duration-500 ease-in-out will-change-[width]',
          height,
          barClass || 'bg-[var(--ema-primary)]',
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
