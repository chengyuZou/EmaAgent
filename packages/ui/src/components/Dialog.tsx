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
            'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm',
            'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
          )}
        />
        <RadixDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'w-[92vw]', widthClass,
            'rounded-lg border border-primary-200/15 bg-neutral-900/95 p-5 shadow-xl',
            'focus:outline-none',
            'data-[state=open]:animate-scale-in',
            className,
          )}
        >
          {(title || description) && (
            <div className="mb-4">
              {title && (
                <RadixDialog.Title className="text-lg font-medium text-neutral-100">
                  {title}
                </RadixDialog.Title>
              )}
              {description && (
                <RadixDialog.Description className="mt-1 text-sm text-neutral-400">
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
                'text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-100 transition-ema',
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
