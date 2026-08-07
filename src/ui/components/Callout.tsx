import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Callout ─────────────────────────────────────────────────────────────────
// 横幅提示:四种语义色,左侧强调色条(::before inset 实现)。

export type CalloutVariant = 'info' | 'success' | 'warn' | 'danger';

export interface CalloutProps {
  variant?:   CalloutVariant;
  title?:     string;
  icon?:      string;
  children?:  ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<CalloutVariant, { bg: string; text: string; stripe: string; icon: string }> = {
  info:    { bg: 'bg-[var(--ema-info-muted)] border-[var(--ema-border)]',       text: 'text-[var(--ema-info-text)]',    stripe: 'before:bg-[var(--ema-info)]/60',    icon: 'i-mdi:information-outline' },
  success: { bg: 'bg-[var(--ema-success-muted)] border-[var(--ema-border)]', text: 'text-[var(--ema-success-text)]', stripe: 'before:bg-[var(--ema-success)]/60', icon: 'i-mdi:check-circle-outline' },
  warn:    { bg: 'bg-[var(--ema-warning-muted)] border-[var(--ema-border)]', text: 'text-[var(--ema-warning-text)]', stripe: 'before:bg-[var(--ema-warning)]/60', icon: 'i-mdi:alert-outline' },
  danger:  { bg: 'bg-[var(--ema-danger-muted)] border-[var(--ema-border)]',   text: 'text-[var(--ema-danger-text)]',  stripe: 'before:bg-[var(--ema-danger)]/70',   icon: 'i-mdi:alert-circle-outline' },
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
