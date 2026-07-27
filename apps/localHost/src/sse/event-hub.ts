import type { TurnId } from '@ema-agent/ids';
import type { EmaStreamEvent } from '@ema-agent/events';

export interface PublishedTurnEvent {
  /**
   * 1-based event cursor within this turn. The replay API uses the number of
   * events already consumed as lastEventId, so an event with cursor N is new
   * for clients whose cursor is < N.
   */
  cursor: number;
  event: EmaStreamEvent;
}

export type TurnEventListener = (published: PublishedTurnEvent) => void;

/**
 * In-process live fan-out for currently connected turn SSE clients.
 *
 * TurnEventStore remains the replay/TTL cache. This hub is deliberately small:
 * it has no history and only pushes newly published events to live subscribers.
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
        // A broken listener should not prevent other SSE clients from receiving
        // the same turn event. The route's cancel path will clean it up.
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
