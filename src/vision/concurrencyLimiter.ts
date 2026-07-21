// 管理 Vision 全局与单 Provider 并发槽位，并为等待请求提供有界队列和取消语义。
import { VisionError } from './errors.js';

export interface VisionConcurrencyLimiter {
  acquire(
    providerId: string,
    maxGlobal: number,
    maxPerProvider: number,
    maxQueued: number,
    signal: AbortSignal,
  ): Promise<() => void>;
}

interface VisionWaiter {
  providerId: string;
  maxGlobal: number;
  maxPerProvider: number;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

export class VisionLimiter implements VisionConcurrencyLimiter {
  private total = 0;
  private readonly byProvider = new Map<string, number>();
  private readonly waiters: VisionWaiter[] = [];

  async acquire(
    providerId: string,
    maxGlobal: number,
    maxPerProvider: number,
    maxQueued: number,
    signal: AbortSignal,
  ): Promise<() => void> {
    if (signal.aborted) throw abortReason(signal);
    if (this.canAcquire(providerId, maxGlobal, maxPerProvider)) {
      return this.grant(providerId);
    }
    if (this.waiters.length >= maxQueued) {
      throw new VisionError('vision/concurrency_limited', 'Vision wait queue is full', {
        providerId,
        retryable: true,
        details: { maxQueued },
      });
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: VisionWaiter = {
        providerId,
        maxGlobal,
        maxPerProvider,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private canAcquire(providerId: string, maxGlobal: number, maxPerProvider: number): boolean {
    return this.total < maxGlobal && (this.byProvider.get(providerId) ?? 0) < maxPerProvider;
  }

  private grant(providerId: string): () => void {
    this.total++;
    this.byProvider.set(providerId, (this.byProvider.get(providerId) ?? 0) + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total = Math.max(0, this.total - 1);
      const nextProvider = Math.max(0, (this.byProvider.get(providerId) ?? 1) - 1);
      if (nextProvider === 0) this.byProvider.delete(providerId);
      else this.byProvider.set(providerId, nextProvider);
      this.drain();
    };
  }

  private drain(): void {
    // Provider 饱和时跳过它，允许队列中其他 Provider 使用剩余的全局槽位。
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!;
      if (waiter.signal.aborted) {
        this.waiters.splice(index, 1);
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      if (!this.canAcquire(waiter.providerId, waiter.maxGlobal, waiter.maxPerProvider)) {
        index++;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(this.grant(waiter.providerId));
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}
