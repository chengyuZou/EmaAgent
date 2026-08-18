// 为单个 Turn 提供单消费者、有界缓存和生产者反压的进程内事件通道。

const DEFAULT_BUFFER_CAPACITY = 64;

export class TurnEventChannelClosedError extends Error {
  constructor() {
    super('turn event consumer is closed');
    this.name = 'TurnEventChannelClosedError';
  }
}

interface PendingRead<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

/**
 * Turn 事件是顺序敏感的增量流，不能让多个消费者争抢同一个 Iterator。
 * 固定容量只吸收生产和消费的短暂速度差；调用方停止消费后会立即通知执行器取消。
 */
export class TurnEventChannel<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly buffer: T[] = [];
  private readonly drainWaiters: Array<() => void> = [];
  private pendingRead: PendingRead<T> | undefined;
  private claimed = false;
  private closed = false;
  private failure: unknown;

  constructor(
    private readonly onConsumerClosed: () => void,
    private readonly capacity = DEFAULT_BUFFER_CAPACITY,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Turn event channel capacity must be a positive integer');
    }
  }

  async push(value: T): Promise<void> {
    if (this.closed) throw new TurnEventChannelClosedError();

    if (this.pendingRead) {
      const pending = this.pendingRead;
      this.pendingRead = undefined;
      pending.resolve({ value, done: false });
      return;
    }

    while (this.buffer.length >= this.capacity && !this.closed) {
      await new Promise<void>((resolve) => {
        this.drainWaiters.push(resolve);
      });
    }

    if (this.closed) throw new TurnEventChannelClosedError();
    this.buffer.push(value);
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseDrainers();
    if (this.pendingRead && this.buffer.length === 0) {
      const pending = this.pendingRead;
      this.pendingRead = undefined;
      pending.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.releaseDrainers();
    if (this.pendingRead && this.buffer.length === 0) {
      const pending = this.pendingRead;
      this.pendingRead = undefined;
      pending.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.claimed) {
      throw new Error('TurnHandle.events only supports one consumer');
    }
    this.claimed = true;
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift()!;
      this.releaseOneDrainer();
      return Promise.resolve({ value, done: false });
    }

    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    if (this.pendingRead) {
      return Promise.reject(new Error('Concurrent reads from TurnHandle.events are not supported'));
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pendingRead = { resolve, reject };
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.buffer.length = 0;
    if (!this.closed) {
      this.onConsumerClosed();
      this.finish();
    }
    return Promise.resolve({ value: undefined, done: true });
  }

  private releaseOneDrainer(): void {
    this.drainWaiters.shift()?.();
  }

  private releaseDrainers(): void {
    while (this.drainWaiters.length > 0) {
      this.drainWaiters.shift()?.();
    }
  }
}
