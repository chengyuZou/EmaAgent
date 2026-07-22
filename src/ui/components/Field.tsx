// 为单个表单控件统一关联标签、说明、必填状态和错误信息。
import {
  Children,
  cloneElement,
  useId,
  type AriaAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
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
  label?:      ReactNode;
  /** Small muted hint below the label. */
  description?: string;
  /** Red error message shown below the input. */
  error?:       string;
  /** Marks the field as required (adds red asterisk). */
  required?:    boolean;
  /** id of the controlled input, used for <label htmlFor>. */
  inputId?:     string;
  className?:   string;
  children:     ReactElement<FieldControlProps>;
}

interface FieldControlProps extends Pick<
  AriaAttributes,
  'aria-describedby' | 'aria-errormessage' | 'aria-invalid' | 'aria-required'
> {
  id?: string;
}

function mergeAriaIds(...values: Array<string | undefined>): string | undefined {
  const ids = values.flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []);
  return ids.length > 0 ? [...new Set(ids)].join(' ') : undefined;
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
  const generatedId = useId();
  const control = Children.only(children);
  const controlId = inputId ?? control.props.id ?? `${generatedId}-control`;
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;
  const describedBy = mergeAriaIds(
    control.props['aria-describedby'],
    descriptionId,
    errorId,
  );
  const enhancedControl = cloneElement(control, {
    id: controlId,
    'aria-describedby': describedBy,
    'aria-errormessage': errorId ?? control.props['aria-errormessage'],
    'aria-invalid': error ? true : control.props['aria-invalid'],
    'aria-required': required || control.props['aria-required'] || undefined,
  });

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {(label || description) && (
        <div>
          {label && (
            <label
              htmlFor={controlId}
              className="flex items-center gap-1 text-sm font-medium text-[var(--ema-text-primary)]"
            >
              {label}
              {required && <span className="text-[var(--ema-danger)]" aria-hidden>*</span>}
            </label>
          )}
          {description && (
            <p id={descriptionId} className="text-xs text-[var(--ema-text-tertiary)] mt-0.5">{description}</p>
          )}
        </div>
      )}
      {enhancedControl}
      {error && (
        <p id={errorId} className="text-xs text-[var(--ema-danger-text)]" role="alert">{error}</p>
      )}
    </div>
  );
}
