import type { CSSProperties, JSX, ReactNode } from 'react';
import { cn } from '../utils/cn.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';

// ── MarketCard ───────────────────────────────────────────────────────────────
//
// Market entry card: left content (title/badges/desc/meta via children) +
// right install/installed button. Replaces SkillsTab + McpTab market cards.
// Decorate prop takes `ema-card-decorate--xxx`; unifies border-2 (Skills vs Mcp had 1px).

export interface MarketCardProps {
  decorate?:       string;
  index?:          number;
  installed:       boolean;
  installing?:     boolean;
  installDisabled?: boolean;
  installLabel?:   string;
  installedLabel?: string;
  onInstall:       () => void;
  className?:      string;
  children:        ReactNode;
}

export function MarketCard({ decorate, index, installed, installing, installDisabled = false, installLabel = '安装', installedLabel = '已安装', onInstall, className, children }: MarketCardProps): JSX.Element {
  return (
    <div
      className={cn(
        'ema-stagger-in ema-glass-weak ema-card-decorate bg-[var(--ema-surface-1)] rounded-xl border-2 border-solid border-[var(--ema-border)]',
        'hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)] px-4 py-3',
        decorate,
        className,
      )}
      style={{ '--stagger-i': index } as CSSProperties}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">{children}</div>
        <div className="shrink-0 pt-0.5">
          {installed ? (
            <Badge variant="success">{installedLabel}</Badge>
          ) : (
            <Button variant="secondary" size="sm" loading={installing} disabled={installing || installDisabled} onClick={onInstall}>
              {installLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
