// 在当前窗口显示最多三条轻量通知，并支持语义颜色、自定义强调色和手动关闭。
/**
 * Minimal toast notification system — chat-column-anchored, bottom-right stack.
 *
 * portal 挂进聊天列([data-ema-chat-column], SessionPage 的 chat Panel)而不是 body:
 * fixed 定位不知右侧 workspace 面板存在, 会整叠压住面板并挡点击。
 * 同文案通知按 ×N 合并, 成功类工具通知不再刷屏。
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
  count: number;
}

// ── Internal state ────────────────────────────────────────────────────────────

let nextId = 1;
const listeners = new Set<() => void>();
let toasts: ToastItem[] = [];

function addToast(message: string, variant: ToastItem['variant'], accentColor?: string): number {
  // 同文案同类型合并计数('工具 Read 执行完成 ×12'), 不再叠满右下角。
  const existing = toasts.find((t) => t.message === message && t.variant === variant);
  if (existing) {
    toasts = toasts.map((t) => (t.id === existing.id ? { ...t, count: t.count + 1 } : t));
    listeners.forEach((fn) => fn());
    return existing.id;
  }
  const id = nextId++;
  toasts = [...toasts.slice(-2), { id, message, variant, accentColor, count: 1 }]; // max 3
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
    <div className="absolute bottom-4 right-4 z-9999 flex max-w-sm flex-col items-end gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex max-w-full items-start gap-2 px-4 py-2 rounded-xl border text-sm ${variantStyles[t.variant]} ${variantBg[t.variant]} ema-fade-in`}
          style={t.accentColor ? { borderColor: t.accentColor } as CSSProperties : undefined}
        >
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          {t.count > 1 && (
            <span className="shrink-0 rounded-full bg-[var(--ema-surface-2)] px-1.5 py-0.5 text-[10px] font-semibold leading-none">
              ×{t.count}
            </span>
          )}
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
  // 挂进聊天列(absolute 相对它定位); 找不到(非聊天窗口)才回落 body。
  const host = document.querySelector('[data-ema-chat-column]') ?? document.body;
  host.appendChild(el);
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
 * 包装一个会原样抛错的异步 action，失败时弹 toast（session 的删除/重命名/置顶/归档
 * 都在置 state.error 后重新 throw）。省掉每个调用点重复的 try/catch+toast。
 *
 * toast 文案为 `<兜底>: <err.message>`，用户同时看到失败的动作与后端的错误细节。
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
