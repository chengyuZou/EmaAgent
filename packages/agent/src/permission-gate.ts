import type { EmaStreamEvent } from '@ema-agent/contracts';
import type {
  PermissionEngine, PermissionOutcome, PermissionContext,
  ToolPermissionMeta, AskPermissionFn,
} from '@ema-agent/permission';

// ── gateWithEvents — async-generator wrapper around permission.gate ─────────

export interface GateWithEventsOptions {
  permission: PermissionEngine;
  toolName:   string;
  args:       unknown;
  meta:       ToolPermissionMeta;
  context:    Omit<PermissionContext, 'ask'>;
  /**
   * Factory that returns the actual askPermission callback. The provided
   * `emit` pushes events into this generator's yield stream; the callback
   * itself blocks on a Promise that the caller's UI layer resolves later.
   *
   * Wiring example (apps/core):
   *   buildAsk: (emit) => async (prompt) => {
   *     const { promptId, promise } = registry.create({ sessionId, turnId });
   *     emit({ type: 'permission_required', promptId, ... });
   *     return promise;
   *   }
   */
  buildAsk: (emit: (ev: EmaStreamEvent) => void) => AskPermissionFn;
}

/**
 * Runs PermissionEngine.gate as a background promise while concurrently
 * yielding any SSE events emitted by the askPermission callback. Returns
 * the PermissionOutcome as the generator's final value.
 *
 * Mirrors the same pattern ConversationEngine uses around the narrative
 * recall hook (streamingBeforeLlm). Required because async generators
 * cannot yield from within an awaited Promise's stack.
 *
 * Usage in the engine:
 *   const outcome = yield* gateWithEvents({ ... });
 */
export async function* gateWithEvents(
  opts: GateWithEventsOptions,
): AsyncGenerator<EmaStreamEvent, PermissionOutcome> {
  const queue: EmaStreamEvent[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let outcome: PermissionOutcome | undefined;
  let error: unknown;

  const emit = (ev: EmaStreamEvent) => {
    queue.push(ev);
    notify?.();
    notify = null;
  };

  const ask = opts.buildAsk(emit);

  opts.permission
    .gate(opts.toolName, opts.args, opts.meta, { ...opts.context, ask })
    .then((r) => {
      outcome = r;
      done = true;
      notify?.();
      notify = null;
    })
    .catch((e: unknown) => {
      error = e;
      done = true;
      notify?.();
      notify = null;
    });

  while (!done || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!;
    if (!done) await new Promise<void>((r) => { notify = r; });
  }

  if (error !== undefined) throw error as Error;
  return outcome!;
}
