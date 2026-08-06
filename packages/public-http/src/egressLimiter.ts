// 限制公网请求的全局和单主机并发，队满或等待取消时立即拒绝。
import { PublicHttpLimitError } from './errors.js';

const MAX_CONCURRENT_GLOBAL = 8;
const MAX_CONCURRENT_PER_HOST = 2;
const MAX_QUEUED = 32;

export class PublicEgressLimiter {
  private total = 0;
  private readonly byHost = new Map<string, number>();
  private readonly waiters: Array<{
    host: string;
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    onAbort: () => void;
  }> = [];

  async acquire(host: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason ?? new Error('公网请求已取消');
    if (this.canAcquire(host)) return this.grant(host);
    if (this.waiters.length >= MAX_QUEUED) {
      throw new PublicHttpLimitError('公网请求并发排队已满');
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        host,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason ?? new Error('公网请求已取消'));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private canAcquire(host: string): boolean {
    return this.total < MAX_CONCURRENT_GLOBAL
      && (this.byHost.get(host) ?? 0) < MAX_CONCURRENT_PER_HOST;
  }

  private grant(host: string): () => void {
    this.total++;
    this.byHost.set(host, (this.byHost.get(host) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total = Math.max(0, this.total - 1);
      const next = Math.max(0, (this.byHost.get(host) ?? 1) - 1);
      if (next === 0) this.byHost.delete(host);
      else this.byHost.set(host, next);
      this.drain();
    };
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!;
      if (waiter.signal.aborted) {
        this.waiters.splice(index, 1);
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(waiter.signal.reason ?? new Error('公网请求已取消'));
        continue;
      }
      if (!this.canAcquire(waiter.host)) {
        index++;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(this.grant(waiter.host));
    }
  }
}

export const publicEgressLimiter = new PublicEgressLimiter();
