/**
 * Serialised task queue — guarantee at-most-one handler invocation at a time.
 *
 * Inspired by AIRI's `packages/stream-kit/src/queue.ts` (96 lines),
 * rewritten for EmaAgent with:
 *   - Generic payload `T`
 *   - `enqueue()` returns a Promise that resolves when this item finishes
 *   - Event emitter (`enqueue` / `process` / `result` / `error` / `drain`)
 *   - `clear()` drops pending items without cancelling the in-flight one
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type QueueEvent =
  | 'enqueue'
  | 'process'
  | 'result'
  | 'error'
  | 'drain';

type Listener = (payload?: unknown) => void;

export interface SendQueue<T> {
  /** Enqueue a payload. Resolves when this item finishes (or rejects on error). */
  enqueue(payload: T): Promise<void>;

  /** Drop all pending items. The in-flight item keeps running. */
  clear(): void;

  /** Number of pending items (NOT including in-flight). */
  size(): number;

  /** Subscribe to queue lifecycle events. Returns unsubscribe fn. */
  on(event: QueueEvent, listener: Listener): () => void;
}

export interface SendQueueOptions<T> {
  handler: (payload: T) => Promise<void>;
  /** Keep draining the queue even after a handler error (default: true). */
  continueOnError?: boolean;
}

// ── Internal item ────────────────────────────────────────────────────────────

interface QueueItem<T> {
  payload: T;
  resolve: () => void;
  reject:  (err: unknown) => void;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createSendQueue<T>(opts: SendQueueOptions<T>): SendQueue<T> {
  const { handler, continueOnError = true } = opts;

  const pending: QueueItem<T>[] = [];
  const listeners = new Map<QueueEvent, Set<Listener>>();
  let running = false;

  // ── Events ────────────────────────────────────────────────────────────────

  function emit(event: QueueEvent, payload?: unknown): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch { /* swallow listener errors */ }
    }
  }

  // ── Drain loop ────────────────────────────────────────────────────────────

  async function drain(): Promise<void> {
    if (running) return;
    running = true;

    while (pending.length > 0) {
      const item = pending.shift()!;  // FIFO
      emit('process', item.payload);
      try {
        await handler(item.payload);
        item.resolve();
        emit('result', item.payload);
      } catch (err: unknown) {
        item.reject(err);
        emit('error', { payload: item.payload, error: err });
        if (!continueOnError) {
          // Reject all remaining pending items
          for (const rest of pending) {
            rest.reject(new Error('Queue stopped due to previous error'));
          }
          pending.length = 0;
          break;
        }
      }
    }

    running = false;
    emit('drain');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    enqueue(payload: T): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        pending.push({ payload, resolve, reject });
        emit('enqueue', payload);
        void drain();
      });
    },

    clear(): void {
      // Reject all pending items
      for (const item of pending) {
        item.reject(new Error('Queue cleared'));
      }
      pending.length = 0;
    },

    size(): number {
      return pending.length;
    },

    on(event: QueueEvent, listener: Listener): () => void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => { set?.delete(listener); };
    },
  };
}
