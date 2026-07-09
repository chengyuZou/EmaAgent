import * as RadixToast from '@radix-ui/react-toast';
import { useSyncExternalStore } from 'react';
import { cn } from '../utils/cn.js';

// ── Toast system ─────────────────────────────────────────────────────────────
//
// Module-level queue — no Provider required at the call site.
// Usage:
//   1. Mount <Toaster /> once at each window root.
//   2. Call toast.success / toast.error / toast.info anywhere (no hook needed).
//
// Architecture: useSyncExternalStore subscribes Toaster to the module store.
// toast() pushes items; each item auto-removes after `duration` ms.

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id:       string;
  message:  string;
  variant:  ToastVariant;
  duration: number;
  /** Override the default variant icon. UnoCSS class. */
  icon?:    string;
}

// ── Module-level store ────────────────────────────────────────────────────────

let _items: ToastItem[] = [];
const _listeners = new Set<() => void>();

function _notify(): void {
  _listeners.forEach((fn) => fn());
}

function _subscribe(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _snapshot(): ToastItem[] {
  return _items;
}

function _push(item: Omit<ToastItem, 'id'>): void {
  const id = crypto.randomUUID();
  _items = [..._items, { id, ...item }];
  _notify();
  setTimeout(() => {
    _items = _items.filter((t) => t.id !== id);
    _notify();
  }, item.duration);
}

// ── Public toast() API ────────────────────────────────────────────────────────

export const toast = {
  success(message: string, duration = 3000, icon?: string): void {
    _push({ message, variant: 'success', duration, icon });
  },
  error(message: string, duration = 5000, icon?: string): void {
    _push({ message, variant: 'error', duration, icon });
  },
  info(message: string, duration = 3000, icon?: string): void {
    _push({ message, variant: 'info', duration, icon });
  },
  warning(message: string, duration = 4000, icon?: string): void {
    _push({ message, variant: 'warning', duration, icon });
  },
};

// ── Styles ────────────────────────────────────────────────────────────────────

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success: 'border-[var(--ema-success)]/30  bg-[var(--ema-success-muted)]  text-[var(--ema-success-text)]',
  error:   'border-[var(--ema-danger)]/30   bg-[var(--ema-danger-muted)]   text-[var(--ema-danger-text)]',
  warning: 'border-[var(--ema-warning)]/30  bg-[var(--ema-warning-muted)]  text-[var(--ema-warning-text)]',
  info:    'border-[var(--ema-primary)]/30  bg-[var(--ema-primary-muted)]  text-[var(--ema-primary-text)]',
};

const VARIANT_ICONS: Record<ToastVariant, string> = {
  success: 'i-mdi:check-circle-outline',
  error:   'i-mdi:alert-circle-outline',
  warning: 'i-mdi:alert-outline',
  info:    'i-mdi:information-outline',
};

// ── Toaster component ─────────────────────────────────────────────────────────

export interface ToasterProps {
  /** Max number of toasts visible at once. Default 5. */
  maxVisible?: number;
  /** UnoCSS icon class for the close button. Defaults to "i-mdi:close". */
  closeIcon?: string;
}

export function Toaster({ maxVisible = 5, closeIcon }: ToasterProps): React.JSX.Element {
  const items = useSyncExternalStore(_subscribe, _snapshot, _snapshot);
  const visible = items.slice(-maxVisible);

  return (
    <RadixToast.Provider swipeDirection="right">
      {visible.map((item) => (
        <RadixToast.Root
          key={item.id}
          duration={item.duration}
          onOpenChange={(open) => {
            if (!open) {
              _items = _items.filter((t) => t.id !== item.id);
              _notify();
            }
          }}
          className={cn(
            'flex items-start gap-3 rounded-lg border px-4 py-3 shadow-xl',
            'backdrop-blur-md',
            'ema-anim-toast',
            VARIANT_CLASSES[item.variant],
          )}
        >
          <span className={cn(item.icon ?? VARIANT_ICONS[item.variant], 'text-lg shrink-0 mt-0.5')} aria-hidden />
          <RadixToast.Description className="text-sm leading-snug flex-1">
            {item.message}
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
          'flex flex-col gap-2 w-80',
          'focus:outline-none',
        )}
      />
    </RadixToast.Provider>
  );
}
