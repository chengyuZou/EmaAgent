import { useSyncExternalStore, type CSSProperties, type JSX } from 'react';
import { createRoot } from 'react-dom/client';

export interface ToastOptions {
  variant?: 'info' | 'success' | 'warning' | 'danger';
  /** null 表示不自动消失, 由调用方或用户关闭; 默认 3000ms. */
  duration?: number | null;
  accentColor?: string;
}

export interface ToastHandle {
  /** 只关闭本次通知; 同文案合并显示的其他通知仍然保留. */
  dismiss(): void;
}

interface ToastItem {
  id: number;
  message: string;
  variant: NonNullable<ToastOptions['variant']>;
  accentColor?: string;
  notificationIds: readonly number[];
}

let nextId = 1;
const listeners = new Set<() => void>();
let toasts: ToastItem[] = [];

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function addToast(message: string, variant: ToastItem['variant'], accentColor?: string): number {
  // 同文案同类型合并计数, 同时最多显示三条.
  const id = nextId++;
  const existing = toasts.find(item => item.message === message && item.variant === variant);
  if (existing) {
    toasts = toasts.map(item => (
      item.id === existing.id
        ? { ...item, notificationIds: [...item.notificationIds, id] }
        : item
    ));
    listeners.forEach(listener => listener());
    return id;
  }
  toasts = [...toasts.slice(-2), { id, message, variant, accentColor, notificationIds: [id] }];
  listeners.forEach(listener => listener());
  return id;
}

function removeToast(id: number): void {
  toasts = toasts.flatMap(item => {
    if (!item.notificationIds.includes(id)) {
      return [item];
    }
    const notificationIds = item.notificationIds.filter(notificationId => notificationId !== id);
    if (notificationIds.length === 0) {
      return [];
    }
    return [{ ...item, notificationIds }];
  });
  listeners.forEach(listener => listener());
}

function removeToastGroup(id: number): void {
  toasts = toasts.filter(item => item.id !== id);
  listeners.forEach(listener => listener());
}

function ToastContainer(): JSX.Element {
  const items = useSyncExternalStore(subscribe, () => toasts);
  return (
    <div className="ema-toast-container" aria-live="polite" aria-relevant="additions text">
      {items.map(item => (
        <div
          key={item.id}
          className="ema-material-toast ema-toast-item ema-fade-in"
          data-toast-id={item.id}
          data-variant={item.variant}
          style={item.accentColor ? { borderColor: item.accentColor } as CSSProperties : undefined}
        >
          <span className="ema-toast-message">{item.message}</span>
          {item.notificationIds.length > 1 && (
            <span className="ema-toast-count">x{item.notificationIds.length}</span>
          )}
          <button
            type="button"
            aria-label="关闭通知"
            className="ema-toast-close"
            onClick={() => removeToastGroup(item.id)}
          >
            <span className="i-mdi:close" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

let mounted = false;

function ensureMounted(): void {
  if (mounted) {
    return;
  }
  mounted = true;
  const element = document.createElement('div');
  element.id = 'desktop-ui-toast-root';
  // 挂在窗口公共区域, 切换 View 不移动通知根节点或重新计时.
  document.body.appendChild(element);
  createRoot(element).render(<ToastContainer />);
}

export function showToast(message: string, options?: ToastOptions): ToastHandle {
  ensureMounted();
  const variant = options?.variant ?? 'info';
  const duration = options?.duration === undefined ? 3000 : options.duration;
  const id = addToast(message, variant, options?.accentColor);
  if (duration !== null) {
    setTimeout(() => removeToast(id), Math.max(0, duration));
  }
  return { dismiss: () => removeToast(id) };
}

/** 已提交操作失败时显示通知, 调用方无需重复捕获同一个错误. */
export function runWithToast<T>(operation: Promise<T>, fallback: string): Promise<T | undefined> {
  return operation.catch((error: unknown) => {
    const message = error instanceof Error ? `${fallback}: ${error.message}` : fallback;
    showToast(message, { variant: 'danger' });
    return undefined;
  });
}
