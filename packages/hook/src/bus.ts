import type { TurnId, SessionId } from '@ema-agent/contracts';
import type { HookEvent, HookPayload } from './events.js';
import { PRIORITY_DEFAULT } from './priority.js';

// ── Context & Result types ────────────────────────────────────────────────────

export interface HookContext<E extends HookEvent> {
  event: E;
  turnId: TurnId;
  sessionId: SessionId;
  payload: HookPayload[E];
  /** Scratchpad shared between handlers within a single trigger() call. Not persisted. */
  meta: Record<string, unknown>;
}

export type HookHandler<E extends HookEvent> = (
  ctx: HookContext<E>,
) => Promise<HookResult> | HookResult;

export type HookResult =
  | { kind: 'continue' }
  | { kind: 'replace'; payload: HookPayload[HookEvent] }
  | { kind: 'abort'; reason: string };

export interface RegisteredHook {
  event: HookEvent;
  name: string;
  priority: number;
}

// ── Internal registration entry ───────────────────────────────────────────────

interface HandlerEntry<E extends HookEvent> {
  handler: HookHandler<E>;
  priority: number;
  name: string;
}

// ── HookBus ───────────────────────────────────────────────────────────────────

export class HookBus {
  // Using a Map<HookEvent, HandlerEntry<E>[]> requires careful casting since
  // TypeScript cannot preserve the generic correlation across a plain Map.
  private readonly registry = new Map<HookEvent, HandlerEntry<HookEvent>[]>();

  /**
   * Register a handler for an event.
   * @returns An unregister function — call it to remove this handler.
   */
  register<E extends HookEvent>(
    event: E,
    handler: HookHandler<E>,
    opts: { priority?: number; name?: string } = {},
  ): () => void {
    const entry: HandlerEntry<E> = {
      handler,
      priority: opts.priority ?? PRIORITY_DEFAULT,
      name: opts.name ?? (handler.name || '<anonymous>'),
    };

    if (!this.registry.has(event)) {
      this.registry.set(event, []);
    }
    const list = this.registry.get(event)!;
    // Cast: HandlerEntry<E> is stored as HandlerEntry<HookEvent> — safe because
    // we only retrieve and call entries keyed under the same event.
    list.push(entry as unknown as HandlerEntry<HookEvent>);
    list.sort((a, b) => a.priority - b.priority);

    return () => {
      const idx = list.indexOf(entry as unknown as HandlerEntry<HookEvent>);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  /**
   * Trigger all handlers for an event serially, in priority order.
   *
   * - A handler returning `{ kind: 'abort' }` stops the chain immediately.
   * - A handler throwing is treated as `{ kind: 'abort', reason: error.message }`.
   * - A handler returning `{ kind: 'replace' }` updates the payload for subsequent handlers.
   */
  async trigger<E extends HookEvent>(
    event: E,
    ctx: Omit<HookContext<E>, 'event'>,
  ): Promise<HookResult> {
    const entries = this.registry.get(event) ?? [];
    if (entries.length === 0) return { kind: 'continue' };

    const fullCtx: HookContext<E> = { ...ctx, event } as HookContext<E>;
    let currentPayload = fullCtx.payload;

    for (const entry of entries) {
      const handlerCtx: HookContext<E> = {
        ...fullCtx,
        payload: currentPayload,
      };

      let result: HookResult;
      try {
        result = await (entry as unknown as HandlerEntry<E>).handler(handlerCtx);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { kind: 'abort', reason };
      }

      if (result.kind === 'abort') return result;
      if (result.kind === 'replace') {
        currentPayload = result.payload as HookPayload[E];
      }
    }

    return { kind: 'continue' };
  }

  /** List registered hooks, optionally filtered by event. */
  list(event?: HookEvent): RegisteredHook[] {
    if (event) {
      return (this.registry.get(event) ?? []).map((e) => ({
        event,
        name: e.name,
        priority: e.priority,
      }));
    }

    const result: RegisteredHook[] = [];
    for (const [evt, entries] of this.registry.entries()) {
      for (const e of entries) {
        result.push({ event: evt, name: e.name, priority: e.priority });
      }
    }
    return result.sort((a, b) => a.priority - b.priority);
  }
}
