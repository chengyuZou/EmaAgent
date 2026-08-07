import { cn } from '../utils/cn.js';

// ── Skeleton ────────────────────────────────────────────────────────────────
// 加载占位:动画类 ema-skeleton-pulse/wave 定义在 desktop-ui styles,
// 与设计系统保持一致;尺寸用 width/height prop 或 className 覆盖。

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
