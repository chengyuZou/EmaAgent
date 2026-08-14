// 向当前在线的 Turn SSE 订阅者广播新事件，不保存任何重放历史。

import type { TurnId } from '@ema-agent/ids';
import type { TurnStreamEvent } from '@ema-agent/events';

export interface PublishedTurnEvent {
  /**
   * Turn 内从 1 开始的事件游标。客户端提交最后已消费游标，服务端只发送更大值。
   */
  cursor: number;
  event: TurnStreamEvent;
}

export type TurnEventListener = (published: PublishedTurnEvent) => void;

/**
 * 进程内实时广播只服务当前连接；重放和 TTL 仍由 TurnEventStore 负责。
 */
export class TurnEventHub {
  private readonly subscribers = new Map<string, Set<TurnEventListener>>();

  subscribe(turnId: TurnId, listener: TurnEventListener): () => void {
    const key = turnId as string;
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(listener);

    return () => {
      const current = this.subscribers.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.subscribers.delete(key);
      }
    };
  }

  publish(turnId: TurnId, published: PublishedTurnEvent): void {
    const set = this.subscribers.get(turnId as string);
    if (!set) return;

    for (const listener of [...set]) {
      try {
        listener(published);
      } catch {
        // 单个失效连接不能阻止其他客户端收到同一事件；Route 取消路径会清理订阅。
      }
    }
  }

  subscriberCount(turnId?: TurnId): number {
    if (turnId) {
      return this.subscribers.get(turnId as string)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.subscribers.values()) {
      total += set.size;
    }
    return total;
  }
}
