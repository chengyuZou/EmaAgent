// 将全局 Toast Store 的有界消息交给当前窗口唯一的 Toaster 渲染。
import * as RadixToast from '@radix-ui/react-toast';
import { useEffect, useId, useSyncExternalStore } from 'react';
import { cn } from '../utils/cn.js';
import { clampFinite } from '../utils/number.js';
import { toastStore } from './toast-store.js';
import type { ToastInput, ToastVariant } from './toast-store.js';

export type { ToastItem, ToastVariant } from './toast-store.js';

function pushToast(input: ToastInput): string {
  return toastStore.enqueue(input);
}

export const toast = {
  success(message: string, duration = 3000, icon?: string): string {
    return pushToast({ message, variant: 'success', duration, icon });
  },
  error(message: string, duration = 5000, icon?: string): string {
    return pushToast({ message, variant: 'error', duration, icon });
  },
  info(message: string, duration = 3000, icon?: string): string {
    return pushToast({ message, variant: 'info', duration, icon });
  },
  warning(message: string, duration = 4000, icon?: string): string {
    return pushToast({ message, variant: 'warning', duration, icon });
  },
  dismiss(id: string): void {
    toastStore.dismiss(id);
  },
  dismissAll(): void {
    toastStore.dismissAll();
  },
};

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success: 'border-[var(--ema-success)]/30 bg-[var(--ema-success-muted)] text-[var(--ema-success-text)]',
  error: 'border-[var(--ema-danger)]/30 bg-[var(--ema-danger-muted)] text-[var(--ema-danger-text)]',
  warning: 'border-[var(--ema-warning)]/30 bg-[var(--ema-warning-muted)] text-[var(--ema-warning-text)]',
  info: 'border-[var(--ema-primary)]/30 bg-[var(--ema-primary-muted)] text-[var(--ema-primary-text)]',
};

const VARIANT_ICONS: Record<ToastVariant, string> = {
  success: 'i-mdi:check-circle-outline',
  error: 'i-mdi:alert-circle-outline',
  warning: 'i-mdi:alert-outline',
  info: 'i-mdi:information-outline',
};

export interface ToasterProps {
  /** 同时显示的最大消息数，范围 1..10，默认 5。 */
  maxVisible?: number;
  closeIcon?: string;
}

export function Toaster({ maxVisible = 5, closeIcon }: ToasterProps): React.JSX.Element {
  const ownerId = useId();
  const snapshot = useSyncExternalStore(
    toastStore.subscribe,
    toastStore.getSnapshot,
    toastStore.getSnapshot,
  );

  useEffect(() => toastStore.registerOwner(ownerId), [ownerId]);

  if (snapshot.ownerId !== ownerId) return <></>;

  const visibleLimit = Math.floor(clampFinite(maxVisible, 1, 10, 5));
  const visible = snapshot.items.slice(-visibleLimit);

  return (
    <RadixToast.Provider swipeDirection="right">
      {visible.map((item) => (
        <RadixToast.Root
          key={item.id}
          open
          duration={Infinity}
          data-toast-id={item.id}
          onOpenChange={(open) => {
            if (!open) toastStore.dismiss(item.id);
          }}
          className={cn(
            'flex items-start gap-3 rounded-lg border px-4 py-3 shadow-xl',
            'backdrop-blur-md ema-anim-toast',
            VARIANT_CLASSES[item.variant],
          )}
        >
          <span
            className={cn(item.icon ?? VARIANT_ICONS[item.variant], 'text-lg shrink-0 mt-0.5')}
            aria-hidden
          />
          <RadixToast.Description className="text-sm leading-snug flex-1">
            {item.message}
            {item.count > 1 && (
              <span className="ml-1 opacity-70" aria-label={`重复 ${item.count} 次`}>
                ×{item.count}
              </span>
            )}
          </RadixToast.Description>
          <RadixToast.Close
            aria-label="关闭"
            className="shrink-0 text-current opacity-50 hover:opacity-100 transition-ema"
          >
            <span className={cn(closeIcon ?? 'i-mdi:close', 'text-base')} aria-hidden />
          </RadixToast.Close>
        </RadixToast.Root>
      ))}

      <RadixToast.Viewport
        className={cn(
          'fixed bottom-4 right-4 z-[9999]',
          'flex flex-col gap-2 w-80 focus:outline-none',
        )}
      />
    </RadixToast.Provider>
  );
}
