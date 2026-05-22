import { cn } from '../utils/cn.js';

// ── Skeleton ────────────────────────────────────────────────────────────────
//
// Loading placeholder. Two animation styles:
//   - pulse: opacity-only breathing (cheap, default)
//   - wave:  ::after gradient sweep (richer, slightly more expensive)
//
// Sized via `width` / `height` props (CSS strings) or className overrides.
// We inject the keyframes once via a single <style> tag — the styled-jsx
// alternative would pull in extra runtime.

export type SkeletonAnimation = 'pulse' | 'wave' | 'none';

export interface SkeletonProps {
  width?:      string | number;
  height?:     string | number;
  animation?:  SkeletonAnimation;
  /** Override the base shape (e.g. rounded-full for avatar). */
  className?:  string;
}

let injected = false;
function ensureKeyframes(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.setAttribute('data-ema-skeleton', '');
  style.textContent = `
    @keyframes ema-skeleton-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.55; }
    }
    @keyframes ema-skeleton-wave {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    .ema-skeleton-wave::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        transparent,
        rgba(255, 255, 255, 0.08),
        transparent
      );
      animation: ema-skeleton-wave 1.6s linear infinite;
    }
  `;
  document.head.appendChild(style);
}

export function Skeleton(props: SkeletonProps): React.JSX.Element {
  const { width, height, animation = 'pulse', className } = props;
  ensureKeyframes();

  const style: React.CSSProperties = {};
  if (width  !== undefined) style.width  = typeof width  === 'number' ? `${width}px`  : width;
  if (height !== undefined) style.height = typeof height === 'number' ? `${height}px` : height;
  if (animation === 'pulse') style.animation = 'ema-skeleton-pulse 1.6s ease-in-out infinite';

  return (
    <span
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        'relative inline-block overflow-hidden rounded-sm bg-neutral-700/55',
        animation === 'wave' && 'ema-skeleton-wave',
        className,
      )}
      style={style}
    />
  );
}
