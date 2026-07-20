// 管理单个窗口内有界、可去重并拥有唯一渲染者的 Toast 队列。
import { clampFinite } from '../utils/number.js';

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
  count: number;
  dedupeKey: string;
  icon?: string;
}

export interface ToastInput {
  message: string;
  variant: ToastVariant;
  duration: number;
  icon?: string;
  dedupeKey?: string;
}

export interface ToastSnapshot {
  items: ToastItem[];
  ownerId: string | null;
}

type ToastListener = () => void;

function createToastId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class ToastStore {
  private readonly listeners = new Set<ToastListener>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private owners: string[] = [];
  private state: ToastSnapshot = { items: [], ownerId: null };

  constructor(
    private readonly capacity = 50,
    private readonly createId: () => string = createToastId,
  ) {}

  readonly subscribe = (listener: ToastListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ToastSnapshot => this.state;

  enqueue(input: ToastInput): string {
    const duration = clampFinite(input.duration, 100, 60_000, 3_000);
    const dedupeKey = input.dedupeKey
      ?? `${input.variant}\u0000${input.message}\u0000${input.icon ?? ''}`;
    const duplicate = this.state.items.find((item) => item.dedupeKey === dedupeKey);

    if (duplicate) {
      const updated = { ...duplicate, duration, count: duplicate.count + 1 };
      this.commit(this.state.items.map((item) => item.id === duplicate.id ? updated : item));
      this.scheduleRemoval(updated);
      return duplicate.id;
    }

    const item: ToastItem = {
      id: this.createId(),
      message: input.message,
      variant: input.variant,
      duration,
      count: 1,
      dedupeKey,
      ...(input.icon ? { icon: input.icon } : {}),
    };
    const capacity = Math.max(1, Math.floor(clampFinite(this.capacity, 1, 500, 50)));
    const nextItems = [...this.state.items, item];
    const overflow = nextItems.slice(0, Math.max(0, nextItems.length - capacity));
    overflow.forEach((entry) => this.clearTimer(entry.id));
    this.commit(nextItems.slice(-capacity));
    this.scheduleRemoval(item);
    return item.id;
  }

  dismiss(id: string): void {
    if (!this.state.items.some((item) => item.id === id)) return;
    this.clearTimer(id);
    this.commit(this.state.items.filter((item) => item.id !== id));
  }

  dismissAll(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    if (this.state.items.length > 0) this.commit([]);
  }

  registerOwner(ownerId: string): () => void {
    if (!this.owners.includes(ownerId)) {
      this.owners = [...this.owners, ownerId];
      this.commitOwner();
    }

    return () => {
      if (!this.owners.includes(ownerId)) return;
      this.owners = this.owners.filter((candidate) => candidate !== ownerId);
      this.commitOwner();
    };
  }

  reset(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.owners = [];
    this.state = { items: [], ownerId: null };
    this.notify();
  }

  private scheduleRemoval(item: ToastItem): void {
    this.clearTimer(item.id);
    this.timers.set(item.id, setTimeout(() => this.dismiss(item.id), item.duration));
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }

  private commit(items: ToastItem[]): void {
    this.state = { ...this.state, items };
    this.notify();
  }

  private commitOwner(): void {
    this.state = { ...this.state, ownerId: this.owners[0] ?? null };
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const toastStore = new ToastStore();
