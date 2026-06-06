import type { TurnId, SessionId, EmaStreamEvent } from '@ema-agent/contracts';
import type { HookEvent, HookPayload } from './events.js';
import { PRIORITY } from './priority.js';

// ── Context & Result types ────────────────────────────────────────────────────

export interface HookContext<E extends HookEvent> {
  event: E;
  payload: HookPayload[E];
  turnId: TurnId;
  sessionId: SessionId;
  /**
   * Shared mutable bag for intra-turn handler communication.
   * All handlers within a single trigger() call — including parallel ones —
   * receive the same reference. Concurrent writes from parallel handlers are
   * safe in Node.js (single-threaded event loop), but would not be safe with
   * Worker Threads. Do not store promises or large objects here.
   */
  meta: Record<string, unknown>;
  emit?: (event: EmaStreamEvent) => void;
}

export type HookTriggerContext<E extends HookEvent> =
  Omit<HookContext<E>, 'event'>;

/**
 * Events whose handlers are allowed to alter control flow.
 *
 * Tool lifecycle events are intentionally absent: tool safety is owned by
 * PermissionEngine + Sandbox, while hooks are observation/UI extension points.
 */
export type ControlHookEvent =
  | 'beforeLlm'
  | 'beforeCompact'
  | 'onTurnStart';

export type ObserverHookEvent = Exclude<HookEvent, ControlHookEvent>;

export type HookControlResult<E extends HookEvent> =
  | { kind: 'continue' }
  | { kind: 'replace'; payload: HookPayload[E] }
  | { kind: 'abort'; reason: string };

export type HookObserverResult = { kind: 'continue' };

/** Result returned by a single hook handler. */
export type HookResult<E extends HookEvent> =
  E extends ControlHookEvent
    ? HookControlResult<E>
    : HookObserverResult;

type HookRuntimeResult<E extends HookEvent> = HookControlResult<E>;

/** Result returned by a whole trigger() chain. */
export type HookTriggerResult<E extends HookEvent> =
  | {
      kind: 'continue';
      payload: HookPayload[E];
      warnings: HookWarning[];
    }
  | {
      kind: 'abort';
      reason: string;
      payload: HookPayload[E];
      warnings: HookWarning[];
    };

export type HookHandler<E extends HookEvent> = (
  ctx: HookContext<E>,
) => Promise<HookResult<E>> | HookResult<E>;

export interface HookWarning {
  event: HookEvent;
  hook: string;
  reason: string;
}

export interface HookOptions {
  priority?: number;
  name?: string;
  critical?: boolean;
  parallel?: boolean;
}

export interface HookBusOptions {
  maxConcurrency?:   number;
  parallelEvents?:   ReadonlySet<HookEvent>;
  /**
   * Called after EVERY handler execution (success or error).
   * Use for structured logging, telemetry, or test assertions.
   *
   * In production, wire this to emit `system_warning` for slow/errored
   * handlers AND to a ring buffer so the settings diagnostics panel
   * can display recent hook activity.
   */
  traceSink?:        (entry: HookTraceEntry) => void;
  /**
   * When true, registering a handler without `opts.name` AND whose
   * function has no `.name` property prints a console warning.
   * Defaults to false — set true in dev / debug builds.
   */
  warnAnonymous?:    boolean;
}

export interface RegisteredHook {
  event: HookEvent;
  name: string;
  priority: number;
  critical: boolean;
  parallel: boolean;
}

// ── Trace ────────────────────────────────────────────────────────────────────

/** Emitted by traceSink after every handler run (success or error). */
export interface HookTraceEntry {
  event:          HookEvent;
  handlerName:    string;
  durationMs:     number;
  result:         'continue' | 'replace' | 'abort' | 'error';
  /** Reason string for abort / error; absent for continue / replace. */
  reason?:        string;
  /** True when the handler returned `kind: 'replace'`. */
  payloadReplaced: boolean;
}

// ── Internal registration entry ───────────────────────────────────────────────

interface HandlerEntry<E extends HookEvent> {
  event: E;
  handler: HookHandler<E>;
  priority: number;
  name: string;
  critical: boolean;
  parallel: boolean;
}

type HookBatch<E extends HookEvent> =
  | { kind: 'serial'; entries: HandlerEntry<E>[] }
  | { kind: 'parallel'; entries: HandlerEntry<E>[] };

// ── Defaults ──────────────────────────────────────────────────────────────────

// All ObserverHookEvents except beforeToolUse run in parallel by default.
// beforeToolUse is intentionally serial: UI renderers need ordered delivery
// (show "pending" before "running") and audit logs need call-order guarantees.
const DEFAULT_PARALLEL_EVENTS = new Set<HookEvent>([
  'afterLlmComplete',
  'afterMessage',
  'afterToolUse',
  'onToolFailure',
  'afterCompact',
  'onTurnEnd',
  'onTurnAbort',
]);

const CONTROL_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set<ControlHookEvent>([
  'beforeLlm',
  'beforeCompact',
  'onTurnStart',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function errorToReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isControlHookEvent(event: HookEvent): event is ControlHookEvent {
  return CONTROL_HOOK_EVENTS.has(event);
}

function observerControlFlowWarning(
  hookName: string,
  result: Exclude<HookRuntimeResult<HookEvent>, HookObserverResult>,
): string {
  if (result.kind === 'abort') {
    return `Observer hook "${hookName}" returned abort (${result.reason}), but observer hooks cannot alter control flow`;
  }
  return `Observer hook "${hookName}" returned replace, but observer hooks cannot alter control flow`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error(`chunk size must be greater than 0, got ${size}`);
  }

  if (size === Number.POSITIVE_INFINITY) {
    return [items];
  }

  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

function buildBatches<E extends HookEvent>(
  entries: HandlerEntry<E>[],
  eventAllowsParallel: boolean,
): HookBatch<E>[] {
  const batches: HookBatch<E>[] = [];

  for (const entry of entries) {
    const canRunParallel = eventAllowsParallel && entry.parallel;
    const last = batches[batches.length - 1];

    if (canRunParallel) {
      if (last?.kind === 'parallel') {
        last.entries.push(entry);
      } else {
        batches.push({
          kind: 'parallel',
          entries: [entry],
        });
      }
    } else {
      batches.push({
        kind: 'serial',
        entries: [entry],
      });
    }
  }

  return batches;
}

// ── HookBus ───────────────────────────────────────────────────────────────────

export class HookBus {
  private readonly registry = new Map<HookEvent, HandlerEntry<HookEvent>[]>();
  private readonly options: HookBusOptions;
  private readonly maxConcurrency: number;
  private readonly parallelEvents: ReadonlySet<HookEvent>;

  constructor(options: HookBusOptions = {}) {
    this.options        = options;
    this.maxConcurrency = options.maxConcurrency ?? Number.POSITIVE_INFINITY;
    this.parallelEvents = options.parallelEvents ?? DEFAULT_PARALLEL_EVENTS;

    if (this.maxConcurrency <= 0) {
      throw new Error(
        `maxConcurrency must be greater than 0, got ${this.maxConcurrency}`,
      );
    }
  }

  /**
   * Register a handler for an event.
   *
   * @returns An unregister function — call it to remove this handler.
   */
  register<E extends HookEvent>(
    event: E,
    handler: HookHandler<E>,
    opts: HookOptions = {},
  ): () => void {
    const entry: HandlerEntry<E> = {
      event,
      handler,
      priority: opts.priority ?? PRIORITY.DEFAULT,
      name: opts.name ?? (handler.name || '<anonymous>'),
      critical: opts.critical ?? true,
      parallel: opts.parallel ?? false,
    };

    if (this.options.warnAnonymous && entry.name === '<anonymous>') {
      console.warn(`[HookBus] anonymous handler registered for "${event}" — pass opts.name for traceability`);
    }

    if (!this.registry.has(event)) {
      this.registry.set(event, []);
    }

    const list = this.registry.get(event)!;

    list.push(entry as unknown as HandlerEntry<HookEvent>);
    list.sort((a, b) => a.priority - b.priority);

    return () => {
      const idx = list.indexOf(entry as unknown as HandlerEntry<HookEvent>);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    };
  }

  /**
   * Trigger all handlers for an event.
   *
   * Rules:
   * - Handlers run by ascending priority.
   * - If the event does not support parallel execution, all handlers run serially.
   * - If the event supports parallel execution, consecutive parallel handlers run
   *   together, bounded by maxConcurrency.
   * - Serial handlers may return replace and update currentPayload.
   * - Parallel handlers must not return replace.
   * - A handler returning abort always aborts the trigger chain.
   * - A thrown/rejected error aborts only if the hook is critical.
   */
  async trigger<E extends HookEvent>(
    event: E,
    ctx: Omit<HookTriggerContext<E>, 'event'>,
  ): Promise<HookTriggerResult<E>> {
    const entries =
      (this.registry.get(event) ?? []) as unknown as HandlerEntry<E>[];

    let currentPayload = ctx.payload as HookPayload[E];
    const warnings: HookWarning[] = [];

    if (entries.length === 0) {
      return {
        kind: 'continue',
        payload: currentPayload,
        warnings,
      };
    }

    const baseCtx: HookContext<E> = {
      ...ctx,
      event,
      payload: currentPayload,
    } as HookContext<E>;

    const eventAllowsParallel = this.parallelEvents.has(event);
    const batches = buildBatches(entries, eventAllowsParallel);

    for (const batch of batches) {
      if (batch.kind === 'serial') {
        for (const entry of batch.entries) {
          const result = await this.runOne(
            event,
            entry,
            baseCtx,
            currentPayload,
            warnings,
          );

          if (!isControlHookEvent(event) && result.kind !== 'continue') {
            warnings.push({
              event,
              hook: entry.name,
              reason: observerControlFlowWarning(entry.name, result),
            });
            continue;
          }

          if (result.kind === 'abort') {
            return {
              kind: 'abort',
              reason: result.reason,
              payload: currentPayload,
              warnings,
            };
          }

          if (result.kind === 'replace') {
            currentPayload = result.payload as HookPayload[E];
          }
        }

        continue;
      }

      const result = await this.runParallelBatch(
        event,
        batch.entries,
        baseCtx,
        currentPayload,
        warnings,
      );

      if (result.kind === 'abort') {
        return {
          kind: 'abort',
          reason: result.reason,
          payload: currentPayload,
          warnings,
        };
      }
    }

    return {
      kind: 'continue',
      payload: currentPayload,
      warnings,
    };
  }

  private async runOne<E extends HookEvent>(
    event: E,
    entry: HandlerEntry<E>,
    baseCtx: HookContext<E>,
    payload: HookPayload[E],
    warnings: HookWarning[],
  ): Promise<HookRuntimeResult<E>> {
    const handlerCtx: HookContext<E> = { ...baseCtx, payload } as HookContext<E>;
    const t0 = performance.now();

    try {
      const result = await entry.handler(handlerCtx) as HookRuntimeResult<E>;
      try {
        this.options.traceSink?.({
          event:           event,
          handlerName:     entry.name,
          durationMs:      performance.now() - t0,
          result:          result.kind,
          reason:          result.kind === 'abort' ? result.reason : undefined,
          payloadReplaced: result.kind === 'replace',
        });
      } catch { /* diagnostic sink must not affect turn flow */ }
      return result;
    } catch (err) {
      const reason = errorToReason(err);
      const durationMs = performance.now() - t0;

      try {
        this.options.traceSink?.({
          event:           event,
          handlerName:     entry.name,
          durationMs,
          result:          'error',
          reason,
          payloadReplaced: false,
        });
      } catch { /* diagnostic sink must not affect turn flow */ }

      if (entry.critical) {
        return {
          kind: 'abort',
          reason,
        };
      }

      warnings.push({
        event,
        hook: entry.name,
        reason,
      });

      return { kind: 'continue' };
    }
  }

  private async runParallelBatch<E extends HookEvent>(
    event: E,
    entries: HandlerEntry<E>[],
    baseCtx: HookContext<E>,
    payload: HookPayload[E],
    warnings: HookWarning[],
  ): Promise<{ kind: 'continue' } | { kind: 'abort'; reason: string }> {
    const chunks = chunkArray(entries, this.maxConcurrency);

    for (const chunk of chunks) {
      const settled = await Promise.allSettled(
        chunk.map((entry) =>
          this.runOne(event, entry, baseCtx, payload, warnings),
        ),
      );

      for (const [i, item] of settled.entries()) {
        const entry = chunk[i]!;

        if (item.status === 'rejected') {
          // runOne catches handler errors, so this is only a defensive fallback.
          const reason = errorToReason(item.reason);

          if (entry.critical) {
            return {
              kind: 'abort',
              reason,
            };
          }

          warnings.push({
            event,
            hook: entry.name,
            reason,
          });

          continue;
        }

        const result = item.value;

        if (!isControlHookEvent(event) && result.kind !== 'continue') {
          warnings.push({
            event,
            hook: entry.name,
            reason: observerControlFlowWarning(entry.name, result),
          });
          continue;
        }

        if (result.kind === 'abort') {
          return {
            kind: 'abort',
            reason: result.reason,
          };
        }

        if (result.kind === 'replace') {
          // Reachable only when a ControlHookEvent is placed in a parallel batch
          // via a custom parallelEvents config — not possible with the default set.
          // Parallel batches structurally cannot propagate payload replacements,
          // so treat it as a protocol violation.
          const reason = `Parallel hook "${entry.name}" returned replace, but parallel hooks cannot replace payload`;

          if (entry.critical) {
            return {
              kind: 'abort',
              reason,
            };
          }

          warnings.push({
            event,
            hook: entry.name,
            reason,
          });

          continue;
        }

        // continue: no-op
      }
    }

    return { kind: 'continue' };
  }

  /** List registered hooks, optionally filtered by event. */
  list(event?: HookEvent): RegisteredHook[] {
    if (event) {
      return (this.registry.get(event) ?? []).map((entry) => ({
        event,
        name: entry.name,
        priority: entry.priority,
        critical: entry.critical,
        parallel: entry.parallel,
      }));
    }

    const result: RegisteredHook[] = [];

    for (const [evt, entries] of this.registry.entries()) {
      for (const entry of entries) {
        result.push({
          event: evt,
          name: entry.name,
          priority: entry.priority,
          critical: entry.critical,
          parallel: entry.parallel,
        });
      }
    }

    return result.sort((a, b) => a.priority - b.priority);
  }
}
