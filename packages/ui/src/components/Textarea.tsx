import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { ReactNode, TextareaHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

// ── Textarea ────────────────────────────────────────────────────────────────
//
// Multi-line text input with:
//   - Auto-grow (height tracks content up to `maxRows`)
//   - `embeddedAction` slot — absolute-positioned ReactNode at bottom-right
//     INSIDE the textarea visual. This is THE slot used by ChatInput for its
//     circular send button. See docs/frontend-skeleton.md §5.
//
// The action is rendered in a sibling positioned div, NOT inside the
// <textarea> element itself (textareas can't contain children). We pad the
// textarea's bottom-right corner to reserve space so typed text never collides
// with the action.

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Right-bottom corner inset slot (e.g. circular send button). */
  embeddedAction?: ReactNode;
  /** Enable height-tracks-content. Default true. */
  autoGrow?:       boolean;
  /** Cap for auto-grow rows. Beyond this, internal scroll kicks in. Default 8. */
  maxRows?:        number;
  /** Min rows shown before any content. Default 3. */
  minRows?:        number;
  error?:          boolean;
}

// 反向 ref handle for callers that want to imperatively focus / clear
export interface TextareaHandle {
  focus(): void;
  blur():  void;
  clear(): void;
  el():    HTMLTextAreaElement | null;
}

export const Textarea = forwardRef<TextareaHandle, TextareaProps>(
  function Textarea(props, ref) {
    const {
      embeddedAction,
      autoGrow = true,
      maxRows  = 8,
      minRows  = 3,
      error,
      className,
      value,
      onChange,
      style,
      ...rest
    } = props;

    const innerRef = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => innerRef.current?.focus(),
      blur:  () => innerRef.current?.blur(),
      clear: () => {
        if (innerRef.current) innerRef.current.value = '';
      },
      el:    () => innerRef.current,
    }), []);

    // ── Auto-grow ───────────────────────────────────────────────────────────
    useEffect(() => {
      if (!autoGrow) return;
      const el = innerRef.current;
      if (!el) return;

      const recompute = (): void => {
        // Reset to auto so we can read the natural scroll height; then clamp.
        el.style.height = 'auto';
        const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 22;
        const minH = lineHeight * minRows;
        const maxH = lineHeight * maxRows;
        const natural = el.scrollHeight;
        const next = Math.min(maxH, Math.max(minH, natural));
        el.style.height = `${next}px`;
        el.style.overflowY = natural > maxH ? 'auto' : 'hidden';
      };

      recompute();
      const observer = new ResizeObserver(recompute);
      observer.observe(el);
      return () => observer.disconnect();
    }, [autoGrow, maxRows, minRows, value]);

    // Reserve room for action (~44px wide + 16px padding on right + 12px bottom)
    const reserveAction = embeddedAction ? { paddingRight: 52, paddingBottom: 48 } : null;

    return (
      <div
        className={cn(
          'relative rounded-md border bg-neutral-900/60 transition-ema',
          'focus-within:border-primary-300 focus-within:ring-2 focus-within:ring-primary-300/40',
          error
            ? 'border-red-400/60 focus-within:ring-red-400/40 focus-within:border-red-400'
            : 'border-neutral-700/50 hover:border-neutral-600',
        )}
      >
        <textarea
          ref={innerRef}
          aria-invalid={error || undefined}
          value={value}
          onChange={onChange}
          rows={minRows}
          className={cn(
            'block w-full resize-none rounded-md bg-transparent px-3 py-2.5',
            'text-sm text-neutral-100 placeholder:text-neutral-500',
            'outline-none focus:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          style={{ ...reserveAction, ...style }}
          {...rest}
        />
        {embeddedAction && (
          <div className="pointer-events-none absolute bottom-3 right-3">
            <div className="pointer-events-auto">{embeddedAction}</div>
          </div>
        )}
      </div>
    );
  },
);
