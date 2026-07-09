import { cn } from '../utils/cn.js';

// ── Field ───────────────────────────────────────────────────────────────────
//
// Form field wrapper. AIRI's field-*.vue pattern ported to React: a consistent
// label → description → input → error layout block.
//
// Use: Every setting form row, every provider editor field.
//
// The `inputId` prop links the <label htmlFor> to the input's `id`, providing
// accessible click-to-focus behaviour without wrapping the input in the label
// (the input is rendered by the consumer as `children`).

export interface FieldProps {
  /** Label text, or ReactNode for rich content. */
  label?:      React.ReactNode;
  /** Small muted hint below the label. */
  description?: string;
  /** Red error message shown below the input. */
  error?:       string;
  /** Marks the field as required (adds red asterisk). */
  required?:    boolean;
  /** id of the controlled input, used for <label htmlFor>. */
  inputId?:     string;
  className?:   string;
  children:     React.ReactNode;
}

export function Field({
  label,
  description,
  error,
  required = false,
  inputId,
  className,
  children,
}: FieldProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {(label || description) && (
        <div>
          {label && (
            <label
              htmlFor={inputId}
              className="flex items-center gap-1 text-sm font-medium text-[var(--ema-text-primary)]"
            >
              {label}
              {required && <span className="text-[var(--ema-danger)]" aria-hidden>*</span>}
            </label>
          )}
          {description && (
            <p className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">{description}</p>
          )}
        </div>
      )}
      {children}
      {error && (
        <p className="text-xs text-[var(--ema-danger-text)]" role="alert">{error}</p>
      )}
    </div>
  );
}
