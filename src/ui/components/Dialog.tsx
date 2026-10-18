import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

interface DialogBaseProps {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  description?: string;
  /** Hide the default close (X) button in the corner. */
  hideClose?:   boolean;
  /** UnoCSS icon class for the close button. Defaults to "i-mdi:close". */
  closeIcon?:   string;
  children:     ReactNode;
  /** 完整类名必须出现在 UnoCSS 扫描范围或 safelist 中. 静态的 w-[500px] 可以扫描,
   *  用运行时变量拼出的类名则需要调用方自行提供样式. */
  widthClass?:  string;
  className?:   string;
}

type DialogAccessibleName =
  | { title: string; ariaLabel?: never }
  | { title?: never; ariaLabel: string };

export type DialogProps = DialogBaseProps & DialogAccessibleName;

export function Dialog(props: DialogProps): React.JSX.Element {
  const {
    open, onOpenChange,
    title, ariaLabel, description, hideClose, closeIcon,
    children, widthClass = 'max-w-md', className,
  } = props;

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={cn(
            'ema-dialog-overlay fixed inset-0 z-[var(--ema-z-dialog)] bg-[var(--ema-mask)] backdrop-blur-sm ema-anim-fade',
          )}
        />
        <RadixDialog.Content
          {...(!description ? { 'aria-describedby': undefined } : {})}
          className={cn(
            'fixed left-1/2 top-1/2 z-[var(--ema-z-dialog)] -translate-x-1/2 -translate-y-1/2',
            'w-[92vw]', widthClass,
            'rounded-xl border border-[var(--ema-border)] bg-[var(--ema-surface-4)] p-5 shadow-[var(--ema-shadow-3)] max-h-[90vh] overflow-auto',
            'focus:outline-none ema-anim-dialog ema-dialog-decorate',
            className,
          )}
        >
          {!title && (
            <RadixDialog.Title className="sr-only">
              {ariaLabel}
            </RadixDialog.Title>
          )}
          {(title || description) && (
            <div className="mb-4">
              {title && (
                <RadixDialog.Title className="text-[17px] font-semibold text-[var(--ema-text-primary)]">
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
              <span className={cn(closeIcon ?? 'i-mdi:close', 'text-base')} aria-hidden />
            </RadixDialog.Close>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
