import { cn } from '../utils/cn.js';

// ── Divider ─────────────────────────────────────────────────────────────────

export interface DividerProps {
  orientation?: 'horizontal' | 'vertical';
  /** Add extra inner margin in flow direction. */
  spaced?:      boolean;
  className?:   string;
}

export function Divider(props: DividerProps): React.JSX.Element {
  const { orientation = 'horizontal', spaced, className } = props;

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'bg-neutral-700/40',
        orientation === 'horizontal'
          ? cn('h-px w-full', spaced && 'my-3')
          : cn('w-px h-full self-stretch', spaced && 'mx-3'),
        className,
      )}
    />
  );
}
