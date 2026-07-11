/**
 * ModelToggleCard - compact model card with a top-right status dot.
 *
 * Click the whole card to toggle enable/disable. Enabled shows a coloured dot
 * (system primary/success); disabled shows nothing - mirrors the provider card
 * dot. Replaces the old long Switch rows in the model managers.
 *
 * Light sweep + dotted texture mirror MenuStatusItem (provider card) exactly:
 * ::before z-0 三段光扫, ::after 点纹, 内容 relative z-1 兜底 -- 直接复用供应商发光.
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
      className={`group relative text-left rounded-lg border-2 border-solid px-2.5 py-2 min-w-0 cursor-pointer outline-none
                  overflow-hidden isolate
                  transition-all duration-[var(--ema-duration-base)] active:scale-[0.97]
                  before:content-empty before:absolute before:inset-0 before:z-0
                  before:w-1/4 before:h-full before:opacity-0
                  before:transition-all before:duration-250 before:ease-in-out
                  before:[mask-image:linear-gradient(120deg,white_30%,transparent_50%)]
                  hover:before:opacity-100 hover:before:w-[85%]
                  hover:before:bg-gradient-to-r hover:before:from-[var(--ema-primary)]/20 hover:before:via-[var(--ema-primary)]/10 hover:before:to-transparent
                  after:content-empty after:absolute after:inset-0 after:z-0 after:w-full after:h-full
                  after:[background-image:radial-gradient(circle_at_25%_25%,color-mix(in_srgb,var(--ema-violet)_32%,transparent),transparent_45%),radial-gradient(circle_at_75%_75%,color-mix(in_srgb,var(--ema-info)_28%,transparent),transparent_50%),radial-gradient(circle,color-mix(in_srgb,var(--ema-text-tertiary)_30%,transparent)_1px,transparent_1.5px)]
                  after:[background-size:100%_100%,100%_100%,10px_10px]
                  after:[mask-image:linear-gradient(165deg,white_30%,transparent_50%)]
                  after:transition-all after:duration-250
                  after:opacity-100 hover:after:[background-size:102%_102%]
                  ${enabled
                    ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
                    : 'border-[var(--ema-border)] bg-[var(--ema-surface-1)] ema-glass-weak hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]'
                  }`}
    >
      {enabled && (
        <span
          className="absolute top-1.5 right-1.5 z-1 size-2 rounded-full bg-[var(--ema-success)] ema-scale-in"
          aria-hidden
        />
      )}
      {logo && (
        <span
          className={`absolute right-1 top-1/2 z-1 -translate-y-1/2 size-6 opacity-40 group-hover:opacity-70 group-hover:scale-110 transition-all duration-[var(--ema-duration-base)] ${logo}`}
          aria-hidden
        />
      )}
      <div className="relative z-1">
        <p className="text-[13px] font-mono font-semibold text-[var(--ema-text-primary)] group-hover:text-[var(--ema-primary-text)] truncate pr-7 leading-tight">{id}</p>
        <div className="flex items-center justify-between gap-1 mt-0.5">
          {badge ? <p className="text-[11px] font-medium text-[var(--ema-text-tertiary)]">{badge}</p> : <span />}
          {action && (
            <span onClick={(e) => e.stopPropagation()}>{action}</span>
          )}
        </div>
      </div>
    </div>
  );
}
