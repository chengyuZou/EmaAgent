// 在当前窗口显示最多三条轻量通知，并支持语义颜色、自定义强调色和手动关闭。
/**
 * Minimal toast notification system — portal-based, bottom-right stack.
 *
 * Self-contained — does NOT import from @ema-agent/ui (avoids circular deps).
 * Uses UnoCSS classes from the shared ui preset.
 */
import { useState, useEffect, useCallback, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToastOptions {
  variant?:  'info' | 'success' | 'warning' | 'danger';
  /** null 表示保持显示，直到用户手动关闭。 */
  duration?: number | null;
  accentColor?: string;
}

export interface ToastHandle {
  dismiss(): void;
}

interface ToastItem {
  id: number;
  message: string;
  variant: Required<ToastOptions>['variant'];
  accentColor?: string;
}

// ── Internal state ────────────────────────────────────────────────────────────

let nextId = 1;
const listeners = new Set<() => void>();
let toasts: ToastItem[] = [];

function addToast(message: string, variant: ToastItem['variant'], accentColor?: string): number {
  const id = nextId++;
  toasts = [...toasts.slice(-2), { id, message, variant, accentColor }]; // max 3
  listeners.forEach((fn) => fn());
  return id;
}

function removeToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  listeners.forEach((fn) => fn());
}

// ── Component ─────────────────────────────────────────────────────────────────

const variantStyles: Record<ToastItem['variant'], string> = {
  info:    'border-[var(--ema-info)] text-[var(--ema-info-text)]',
  success: 'border-[var(--ema-success)] text-[var(--ema-success-text)]',
  warning: 'border-[var(--ema-warning)] text-[var(--ema-warning-text)]',
  danger:  'border-[var(--ema-danger)] text-[var(--ema-danger-text)]',
};

const variantBg: Record<ToastItem['variant'], string> = {
  info:    'bg-[var(--ema-info-muted)]',
  success: 'bg-[var(--ema-success-muted)]',
  warning: 'bg-[var(--ema-warning-muted)]',
  danger:  'bg-[var(--ema-danger-muted)]',
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
          className={`pointer-events-auto flex items-start gap-2 px-4 py-2 rounded-xl border text-sm ${variantStyles[t.variant]} ${variantBg[t.variant]} ema-fade-in`}
          style={t.accentColor ? { borderColor: t.accentColor } as CSSProperties : undefined}
        >
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button
            type="button"
            aria-label="关闭通知"
            className="mt-0.5 shrink-0 cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
            onClick={() => removeToast(t.id)}
          >
            <span className="i-mdi:close text-sm" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Lazy portal mount ─────────────────────────────────────────────────────────

let mounted = false;

function ensureMounted(): void {
  if (mounted) return;
  mounted = true;
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
export function showToast(message: string, opts?: ToastOptions): ToastHandle {
  ensureMounted();
  const variant = opts?.variant ?? 'info';
  const duration = opts?.duration ?? 3000;

  const id = addToast(message, variant, opts?.accentColor);
  if (duration !== null) setTimeout(() => removeToast(id), Math.max(0, duration));
  return { dismiss: () => removeToast(id) };
}

/**
 * Run an async store action, toasting on failure. Pairs with store methods that
 * re-throw on error (e.g. session-store's delete/rename/pin/archive all
 * `throw err` after setting state.error). Avoids repeating try/catch+toast at
 * every call site.
 *
 * The toast shows `<fallback>: <err.message>` so the user sees both the action
 * that failed and the backend's error detail.
 *
 * @example
 *   void runWithToast(store.deleteSession(id), '删除失败');
 */
export function runWithToast<T>(p: Promise<T>, fallback: string): Promise<T | undefined> {
  return p.catch((err: unknown) => {
    const msg = err instanceof Error ? `${fallback}: ${err.message}` : fallback;
    showToast(msg, { variant: 'danger' });
    return undefined;
  });
}
