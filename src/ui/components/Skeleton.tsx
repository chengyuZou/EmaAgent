import { cn } from '../utils/cn.js';

export type SkeletonAnimation = 'pulse' | 'wave' | 'none';

export interface SkeletonProps {
  width?:      string | number;
  height?:     string | number;
  animation?:  SkeletonAnimation;
  /** Override the base shape (e.g. rounded-full for avatar). */
  className?:  string;
}

export function Skeleton(props: SkeletonProps): React.JSX.Element {
  const { width, height, animation = 'pulse', className } = props;

  const style: React.CSSProperties = {};
  if (width  !== undefined) style.width  = typeof width  === 'number' ? `${width}px`  : width;
  if (height !== undefined) style.height = typeof height === 'number' ? `${height}px` : height;

  return (
    <span
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        'relative inline-block overflow-hidden rounded-sm bg-[var(--ema-surface-2)]',
        animation === 'pulse' && 'ema-skeleton-pulse',
        animation === 'wave' && 'ema-skeleton-wave',
        className,
      )}
      style={style}
    />
  );
}
