import { cn } from '../utils/cn.js';

// ── Spinner ─────────────────────────────────────────────────────────────────
//
// Standalone loading indicator. For in-button loading state use
// Button/IconButton's `loading` prop instead.

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
      className={cn('i-svg-spinners:ring-resize text-primary-300', SIZE_CLASSES[size], className)}
    />
  );
}
