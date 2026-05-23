/**
 * Minimal toast notification system — portal-based, bottom-right stack.
 *
 * Self-contained — does NOT import from @ema-agent/ui (avoids circular deps).
 * Uses UnoCSS classes from the shared ui preset.
 */
import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToastOptions {
  variant?:  'info' | 'success' | 'warning' | 'danger';
  duration?: number;
}

interface ToastItem {
  id: number;
  message: string;
  variant: Required<ToastOptions>['variant'];
}

// ── Internal state ────────────────────────────────────────────────────────────

let nextId = 1;
const listeners = new Set<() => void>();
let toasts: ToastItem[] = [];

function addToast(message: string, variant: ToastItem['variant']): void {
  toasts = [...toasts.slice(-2), { id: nextId++, message, variant }]; // max 3
  listeners.forEach((fn) => fn());
}

function removeToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  listeners.forEach((fn) => fn());
}

// ── Component ─────────────────────────────────────────────────────────────────

const variantColors: Record<ToastItem['variant'], string> = {
  info:    'bg-blue-500/20 border-blue-400/40 text-blue-200',
  success: 'bg-green-500/20 border-green-400/40 text-green-200',
  warning: 'bg-yellow-500/20 border-yellow-400/40 text-yellow-200',
  danger:  'bg-red-500/20 border-red-400/40 text-red-200',
};

function ToastContainer(): JSX.Element {
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    listeners.add(rerender);
    return () => { listeners.delete(rerender); };
  }, [rerender]);

  if (toasts.length === 0) return <></>;

  return (
    <div className="fixed bottom-4 right-4 z-9999 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto px-4 py-2 rounded-xl border text-sm ${variantColors[t.variant]} animate-fade-in`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ── Lazy portal mount ─────────────────────────────────────────────────────────

let _mounted = false;

function ensureMounted(): void {
  if (_mounted) return;
  _mounted = true;
  const el = document.createElement('div');
  el.id = 'desktop-ui-toast-root';
  document.body.appendChild(el);
  createRoot(el).render(<ToastContainer />);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Show a toast notification. Auto-dismisses after `opts.duration` ms (default 3000).
 *
 * @example
 *   showToast('操作成功', { variant: 'success' });
 *   showToast('连接失败', { variant: 'danger', duration: 5000 });
 */
export function showToast(message: string, opts?: ToastOptions): void {
  ensureMounted();
  const variant = opts?.variant ?? 'info';
  const duration = opts?.duration ?? 3000;

  addToast(message, variant);

  // Remove after duration
  setTimeout(() => {
    const last = toasts[toasts.length - 1];
    if (last) removeToast(last.id);
  }, duration);
}
