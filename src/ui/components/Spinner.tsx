import { cn } from '../utils/cn.js';

// ── Spinner ─────────────────────────────────────────────────────────────────
// 独立加载指示器;按钮内加载态请用 Button/IconButton 的 loading prop。

export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps {
  size?:      SpinnerSize;
  className?: string;
  /** Accessible label; defaults to "Loading". */
  label?:     string;
}

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  sm: 'text-base',
  md: 'text-xl',
  lg: 'text-3xl',
};

export function Spinner(props: SpinnerProps): React.JSX.Element {
  const { size = 'md', className, label = 'Loading' } = props;
  return (
    <span
      role="status"
      aria-label={label}
      className={cn('i-svg-spinners:ring-resize text-[var(--ema-primary)]', SIZE_CLASSES[size], className)}
    />
  );
}
