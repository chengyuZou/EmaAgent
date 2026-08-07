// 提供带焦点管理、遮罩和强制无障碍名称的模态对话框。
import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../utils/cn.js';

// ── Dialog ──────────────────────────────────────────────────────────────────
// 模态对话框:确认/输入/危险操作门禁。
// 基于 Radix,自带焦点陷阱、Esc 关闭、滚动锁定与无障碍关联。

interface DialogBaseProps {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  description?: string;
  /** Hide the default close (X) button in the corner. */
  hideClose?:   boolean;
  /** UnoCSS icon class for the close button. Defaults to "i-mdi:close". */
  closeIcon?:   string;
  children:     ReactNode;
  /** Override max width. Must be a static UnoCSS class (e.g. 'max-w-lg', 'max-w-2xl').
   *  Do NOT pass dynamic bracket values like 'w-[500px]' — UnoCSS cannot scan them. */
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
            'fixed inset-0 z-50 bg-[var(--ema-mask)] backdrop-blur-sm ema-anim-fade',
          )}
        />
        <RadixDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'w-[92vw]', widthClass,
            'rounded-lg border border-[var(--ema-border)] bg-[var(--ema-surface-4)] p-5 shadow-[var(--ema-shadow-3)] max-h-[90vh] overflow-auto',
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
              <span className={cn(closeIcon ?? 'i-mdi:close', 'text-base')} aria-hidden />
            </RadixDialog.Close>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
