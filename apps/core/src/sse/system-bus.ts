import type { EmaStreamEvent } from '@ema-agent/contracts';

// ── SystemEventBus ───────────────────────────────────────────────────────────

/**
 * In-process pub/sub for events that aren't tied to a single turn.
 *
 * Two-channel architecture:
 *   per-turn  →  Orchestrator.run() async iterable  →  TurnEventStore
 *                                                  →  GET /api/turns/:id/events
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
  private readonly subscribers = new Set<(ev: EmaStreamEvent) => void>();

  subscribe(handler: (ev: EmaStreamEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  emit(ev: EmaStreamEvent): void {
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
