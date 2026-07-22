import type { CSSProperties, JSX, ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── EntityRow ────────────────────────────────────────────────────────────────
//
// Generic list-item card base: decorate + active/inactive border + stagger.
// Padding/layout/actions passed via className + children (slot pattern) so the
// 12 heterogeneous list items (CardListItem / NodeRow / ServerRow / DocumentRow
// / LibraryRow / IngestJobRow / DataDirRow / SessionRow / RefAudioRow /
// ShortcutRow / SkillRow / ItemRow) can share one base without forcing a layout.
//
// Renders <button> when onClick is given (clickable row), else <div>.

export interface EntityRowProps {
  /** `ema-card-decorate--xxx` variant. */
  decorate?: string;
  /** Selected/active state: primary border + primary-muted bg. */
  active?:   boolean;
  /** If given, renders a <button> (clickable row). */
  onClick?:  () => void;
  /** Stagger index for `ema-stagger-in`. */
  index?:    number;
  /** Padding + flex layout (e.g. "p-5 flex flex-col gap-3"). */
  className?: string;
  children:  ReactNode;
}

export function EntityRow({ decorate, active, onClick, index, className, children }: EntityRowProps): JSX.Element {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'ema-stagger-in ema-glass-weak ema-card-decorate bg-[var(--ema-surface-1)] rounded-xl border-2 border-solid text-left',
        active
          ? 'border-[var(--ema-primary)] bg-[var(--ema-primary-muted)]'
          : 'border-[var(--ema-border)] hover:border-[var(--ema-primary)]/30 hover:bg-[var(--ema-surface-2)] hover:shadow-[var(--ema-shadow-soft)]',
        decorate,
        className,
      )}
      style={{ '--stagger-i': index } as CSSProperties}
    >
      {children}
    </Comp>
  );
}
