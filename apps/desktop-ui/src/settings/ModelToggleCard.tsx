/**
 * ModelToggleCard - compact model card with a top-right status dot.
 *
 * Click the whole card to toggle enable/disable. Enabled shows a coloured dot
 * (system primary/success); disabled shows nothing - mirrors the provider card
 * dot. Replaces the old long Switch rows in the model managers.
 */
import type { JSX, ReactNode } from 'react';

export interface ModelToggleCardProps {
  id:       string;
  /** Short meta line, e.g. "128K ctx" or "1024d". */
  badge?:   string;
  enabled:  boolean;
  onToggle(): void;
  /** Optional corner action (e.g. TTS test button); clicks don't toggle. */
  action?:  ReactNode;
  /** Provider logo icon class (e.g. i-lobe-icons:openai) - right-edge peek. */
  logo?:    string;
}

export function ModelToggleCard({ id, badge, enabled, onToggle, action, logo }: ModelToggleCardProps): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      title={id}
      className={`group relative text-left rounded-lg border px-2.5 py-2 min-w-0 cursor-pointer outline-none
                  transition-all duration-[var(--ema-duration-base)] active:scale-[0.97]
                  ${enabled
                    ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                    : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-glass-weak hover:border-[var(--ema-border-hover)] ema-card-decorate'
                  }`}
    >
      {enabled && (
        <span
          className="absolute top-1.5 right-1.5 size-2 rounded-full bg-[var(--ema-success)] ema-scale-in"
          aria-hidden
        />
      )}
      {logo && (
        <span
          className={`absolute right-1 top-1/2 -translate-y-1/2 size-5 opacity-25 group-hover:opacity-60 transition-opacity ${logo}`}
          aria-hidden
        />
      )}
      <p className="text-xs font-mono text-[var(--ema-text-primary)] truncate pr-7 leading-tight">{id}</p>
      <div className="flex items-center justify-between gap-1 mt-0.5">
        {badge ? <p className="text-[10px] text-[var(--ema-text-tertiary)]">{badge}</p> : <span />}
        {action && (
          <span onClick={(e) => e.stopPropagation()}>{action}</span>
        )}
      </div>
    </div>
  );
}
