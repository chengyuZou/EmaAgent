import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Dialog ──────────────────────────────────────────────────────────────────
//
// Modal dialog. Used for confirmations, prompts, dangerous-action gating.
// Built on Radix — handles focus trap, escape close, scroll lock, a11y.

export interface DialogProps {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  title?:       string;
  description?: string;
  /** Hide the default close (X) button in the corner. */
  hideClose?:   boolean;
  children:     ReactNode;
  /** Override max width. Must be a static UnoCSS class (e.g. 'max-w-lg', 'max-w-2xl').
   *  Do NOT pass dynamic bracket values like 'w-[500px]' — UnoCSS cannot scan them. */
  widthClass?:  string;
  className?:   string;
}

export function Dialog(props: DialogProps): React.JSX.Element {
  const {
    open, onOpenChange,
    title, description, hideClose,
    children, widthClass = 'max-w-md', className,
  } = props;

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-[var(--ema-mask)] backdrop-blur-sm ema-anim-fade',
          )}
        />
        <RadixDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'w-[92vw]', widthClass,
            'rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-4)] p-5 shadow-[var(--ema-shadow-3)]',
            'focus:outline-none ema-anim-dialog',
            className,
          )}
        >
          {(title || description) && (
            <div className="mb-4">
              {title && (
                <RadixDialog.Title className="text-lg font-medium text-[var(--ema-text-primary)]">
                  {title}
                </RadixDialog.Title>
              )}
              {description && (
                <RadixDialog.Description className="mt-1 text-sm text-[var(--ema-text-tertiary)]">
                  {description}
                </RadixDialog.Description>
              )}
            </div>
          )}

          {children}

          {!hideClose && (
            <RadixDialog.Close
              aria-label="关闭"
              className={cn(
                'absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full',
                'text-[var(--ema-text-tertiary)] hover:bg-[var(--ema-surface-2)] hover:text-[var(--ema-text-primary)] transition-ema',
                'focus-ring',
              )}
            >
              <span className="i-mdi:close text-base" aria-hidden />
            </RadixDialog.Close>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
