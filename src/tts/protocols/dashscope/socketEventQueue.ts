type QueueEntry<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'done' };

export class SocketEventQueue<T> {
  private readonly entries: QueueEntry<T>[] = [];
  private readonly waiters: Array<(entry: QueueEntry<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    this.enqueue({ kind: 'value', value });
  }

  close(): void {
    this.enqueue({ kind: 'done' });
  }

  fail(error: unknown): void {
    if (this.closed) return;
    // 失败或取消后丢弃尚未消费的音频, 下一次读取直接收到错误.
    this.entries.length = 0;
    this.enqueue({ kind: 'error', error });
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      const entry = this.entries.shift() ?? await new Promise<QueueEntry<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (entry.kind === 'done') return;
      if (entry.kind === 'error') throw entry.error;
      yield entry.value;
    }
  }

  private enqueue(entry: QueueEntry<T>): void {
    if (this.closed) return;
    if (entry.kind !== 'value') this.closed = true;
    const waiter = this.waiters.shift();
    if (waiter) waiter(entry);
    else this.entries.push(entry);
  }
}
