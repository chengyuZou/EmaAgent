// 在全局并发上限内按 Session FIFO、公平轮转启动后台命令。

import type { SessionId } from '@ema-agent/ids';

interface ScheduledStart {
  readonly id: string;
  readonly start: () => void;
  readonly cancel: (reason: Error) => void;
}

export class BackgroundProcessScheduler {
  private readonly queues = new Map<SessionId, ScheduledStart[]>();
  private readonly sessionOrder: SessionId[] = [];
  private activeCount = 0;
  private cursor = 0;

  constructor(private readonly maxConcurrent: () => number) {}

  enqueue(sessionId: SessionId, item: ScheduledStart): void {
    const queue = this.queues.get(sessionId);
    if (queue) queue.push(item);
    else {
      this.queues.set(sessionId, [item]);
      this.sessionOrder.push(sessionId);
    }
    this.pump();
  }

  cancel(id: string, reason: Error): boolean {
    for (const [sessionId, queue] of this.queues) {
      const index = queue.findIndex(item => item.id === id);
      if (index < 0) continue;
      const [item] = queue.splice(index, 1);
      item?.cancel(reason);
      this.removeEmptySession(sessionId);
      return true;
    }
    return false;
  }

  release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.pump();
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrent() && this.sessionOrder.length > 0) {
      if (this.cursor >= this.sessionOrder.length) this.cursor = 0;
      const sessionId = this.sessionOrder[this.cursor];
      const queue = sessionId ? this.queues.get(sessionId) : undefined;
      const item = queue?.shift();
      if (!sessionId || !queue || !item) {
        if (sessionId) this.removeEmptySession(sessionId);
        else this.sessionOrder.splice(this.cursor, 1);
        continue;
      }

      this.activeCount += 1;
      if (queue.length === 0) this.removeEmptySession(sessionId);
      else this.cursor = (this.cursor + 1) % this.sessionOrder.length;
      item.start();
    }
  }

  private removeEmptySession(sessionId: SessionId): void {
    this.queues.delete(sessionId);
    const index = this.sessionOrder.indexOf(sessionId);
    if (index < 0) return;
    this.sessionOrder.splice(index, 1);
    if (index < this.cursor) this.cursor -= 1;
    if (this.cursor >= this.sessionOrder.length) this.cursor = 0;
  }
}
