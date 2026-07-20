// 测试 Toast 队列的容量、去重计数、计时器和唯一 owner 交接。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastStore } from '../src/components/toast-store.js';

let nextId: number;
let store: ToastStore;

beforeEach(() => {
  vi.useFakeTimers();
  nextId = 1;
  store = new ToastStore(3, () => `toast-${nextId++}`);
});

afterEach(() => {
  store.reset();
  vi.useRealTimers();
});

describe('ToastStore', () => {
  it('deduplicates repeated messages and restarts their removal timer', () => {
    const firstId = store.enqueue({
      message: '连接失败',
      variant: 'error',
      duration: 1000,
    });
    vi.advanceTimersByTime(900);
    const repeatedId = store.enqueue({
      message: '连接失败',
      variant: 'error',
      duration: 1000,
    });

    expect(repeatedId).toBe(firstId);
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(store.getSnapshot().items[0]?.count).toBe(2);

    vi.advanceTimersByTime(200);
    expect(store.getSnapshot().items).toHaveLength(1);
    vi.advanceTimersByTime(800);
    expect(store.getSnapshot().items).toHaveLength(0);
  });

  it('evicts the oldest item when the bounded capacity is exceeded', () => {
    for (let index = 1; index <= 4; index += 1) {
      store.enqueue({
        message: `message-${index}`,
        variant: 'info',
        duration: 5000,
      });
    }

    expect(store.getSnapshot().items.map((item) => item.message)).toEqual([
      'message-2',
      'message-3',
      'message-4',
    ]);
  });

  it('assigns one owner and transfers ownership after unmount', () => {
    const releaseFirst = store.registerOwner('first');
    const releaseSecond = store.registerOwner('second');

    expect(store.getSnapshot().ownerId).toBe('first');
    releaseFirst();
    expect(store.getSnapshot().ownerId).toBe('second');
    releaseSecond();
    expect(store.getSnapshot().ownerId).toBeNull();
  });
});
