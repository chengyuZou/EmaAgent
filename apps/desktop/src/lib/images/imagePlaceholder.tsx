import { Skeleton } from '@ema-agent/ui';
import type { JSX } from 'react';

export function ImagePlaceholder({ failed = false, className }: {
  failed?: boolean;
  className?: string;
}): JSX.Element {
  if (!failed) {
    return <Skeleton animation="wave" className={`ema-image-placeholder ${className ?? ''}`} />;
  }
  return (
    <svg
      className={`ema-image-placeholder ema-image-placeholder-failed ${className ?? ''}`}
      viewBox="0 0 160 120"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="图片无法加载"
    >
      <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" opacity="0.7">
        <path d="M94 70H51V31h54v21" />
        <path d="m52 62 15-16 16 16 8-8 10 10" />
        <circle cx="90" cy="42" r="3" fill="currentColor" stroke="none" />
        <circle cx="105" cy="67" r="12" />
        <path d="M105 60v8" strokeLinecap="round" />
        <circle cx="105" cy="73" r="1.5" fill="currentColor" stroke="none" />
      </g>
      <text x="80" y="98" textAnchor="middle" fill="currentColor" fontSize="12">
        图片无法加载
      </text>
    </svg>
  );
}
