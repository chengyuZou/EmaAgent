import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Callout ─────────────────────────────────────────────────────────────────
//
// Banner / notice. Four semantic colors. Has a left accent stripe
// (via ::before pseudo using inset border-left).

export type CalloutVariant = 'info' | 'success' | 'warn' | 'danger';

export interface CalloutProps {
  variant?:   CalloutVariant;
  title?:     string;
  icon?:      string;
  children?:  ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<CalloutVariant, { bg: string; text: string; stripe: string; icon: string }> = {
  info:    { bg: 'bg-sky-500/12 border-sky-400/30',    text: 'text-sky-100',    stripe: 'before:bg-sky-400/60',    icon: 'i-mdi:information-outline' },
  success: { bg: 'bg-green-500/12 border-green-400/30', text: 'text-green-100', stripe: 'before:bg-green-400/60', icon: 'i-mdi:check-circle-outline' },
  warn:    { bg: 'bg-amber-500/12 border-amber-400/30', text: 'text-amber-100', stripe: 'before:bg-amber-400/60', icon: 'i-mdi:alert-outline' },
  danger:  { bg: 'bg-red-500/15 border-red-400/40',     text: 'text-red-100',   stripe: 'before:bg-red-400/70',   icon: 'i-mdi:alert-circle-outline' },
};

export function Callout(props: CalloutProps): React.JSX.Element {
  const { variant = 'info', title, icon, children, className } = props;
  const v = VARIANT_CLASSES[variant];

  return (
    <div
      role="note"
      className={cn(
        'relative rounded-md border pl-4 pr-3 py-3',
        "before:content-empty before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:rounded-l-md",
        v.bg, v.text, v.stripe, className,
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn(icon ?? v.icon, 'text-lg mt-0.5 shrink-0')} aria-hidden />
        <div className="flex-1">
          {title && <div className="font-medium mb-0.5">{title}</div>}
          {children && <div className="text-sm opacity-90">{children}</div>}
        </div>
      </div>
    </div>
  );
}
