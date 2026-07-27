import type { AppEvent } from '@ema-agent/events';

// ── SystemEventBus ───────────────────────────────────────────────────────────

/**
 * In-process pub/sub for events that aren't tied to a single turn.
 *
 * Two-channel architecture:
 *   per-turn  →  TurnHandle.events  →  TurnEventStore
 *                                      →  GET /api/turns/:id/events
 *   system    →  SystemEventBus (this)              →  multiple SSE subscribers
 *                                                  →  GET /api/system/events
 *
 * Producers (memory pipeline / background runner / card-switch emitter /
 * provider-health probes) call `emit(ev)`. Subscribers (HTTP SSE clients)
 * call `subscribe(handler)` to receive every future event.
 *
 * No replay buffer — system events are advisory ("memory extraction finished",
 * "background task failed"). Late subscribers miss earlier events; that's fine.
 * If we ever need durable replay for system events, persist to a tail table.
 */
export class SystemEventBus {
  private readonly subscribers = new Set<(ev: AppEvent) => void>();

  subscribe(handler: (ev: AppEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  emit(ev: AppEvent): void {
    for (const fn of this.subscribers) {
      try { fn(ev); }
      catch (err) {
        console.warn('[system-bus] subscriber threw:', err);
      }
    }
  }

  /** Diagnostics — connected SSE client count. */
  subscriberCount(): number {
    return this.subscribers.size;
  }
}
