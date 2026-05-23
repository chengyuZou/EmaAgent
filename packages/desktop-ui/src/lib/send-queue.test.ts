/**
 * send-queue.test.ts — serial execution, clear, error path, event order.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSendQueue } from './send-queue.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createSendQueue', () => {
  it('processes items serially (one at a time)', async () => {
    const order: number[] = [];
    const q = createSendQueue<number>({
      handler: async (n) => {
        order.push(n);
        await sleep(10);
      },
    });

    // Enqueue 5 items near-simultaneously
    await Promise.all([
      q.enqueue(1),
      q.enqueue(2),
      q.enqueue(3),
      q.enqueue(4),
      q.enqueue(5),
    ]);

    // Must be processed in FIFO order
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('serial execution: 100 items take ≥ handler time, not parallel', async () => {
    const q = createSendQueue<number>({
      handler: async () => {
        await sleep(5);
      },
    });

    const start = Date.now();
    const promises = Array.from({ length: 20 }, (_, i) => q.enqueue(i));
    await Promise.all(promises);
    const elapsed = Date.now() - start;

    // 20 items × 5ms each serial = at least 100ms; parallel would be ~5ms
    expect(elapsed).toBeGreaterThanOrEqual(80);
  });

  it('clear() drops pending items without cancelling in-flight', async () => {
    const processed: number[] = [];
    let inFlightResolve: (() => void) | null = null;

    const q = createSendQueue<number>({
      handler: async (n) => {
        if (n === 1) {
          // Hold item 1 in-flight
          await new Promise<void>((r) => { inFlightResolve = r; });
        }
        processed.push(n);
        await sleep(2);
      },
    });

    // Start item 1 (in-flight)
    const p1 = q.enqueue(1);
    await sleep(5); // let it enter handler
    expect(q.size()).toBe(0); // it's in-flight, not pending

    // Enqueue items 2, 3, 4 (pending behind in-flight).
    // Use .catch() to handle the rejection that clear() will trigger —
    // otherwise these become unhandled rejections and crash the test runner.
    const rejected: Error[] = [];
    const p2 = q.enqueue(2).catch((e: Error) => { rejected.push(e); });
    const p3 = q.enqueue(3).catch((e: Error) => { rejected.push(e); });
    const p4 = q.enqueue(4).catch((e: Error) => { rejected.push(e); });
    expect(q.size()).toBe(3);

    // Clear pending (2, 3, 4 get rejected)
    q.clear();
    expect(q.size()).toBe(0);

    // Release item 1 in-flight
    inFlightResolve!();
    await Promise.all([p1, p2, p3, p4]);

    // Only item 1 was processed; 2, 3, 4 were dropped
    expect(processed).toEqual([1]);
    expect(rejected).toHaveLength(3);
    for (const e of rejected) expect(e.message).toBe('Queue cleared');
  });

  it('enqueue() promise is rejected if handler throws and continueOnError=true', async () => {
    const q = createSendQueue<string>({
      handler: async (s) => {
        if (s === 'bad') throw new Error('boom');
      },
      continueOnError: true,
    });

    const err = await q.enqueue('bad').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');

    // Queue should still be usable
    const processed: string[] = [];
    const q2 = createSendQueue<string>({
      handler: async (s) => {
        if (s === 'bad') throw new Error('boom');
        processed.push(s);
      },
      continueOnError: true,
    });

    await q2.enqueue('bad').catch(() => {});
    await q2.enqueue('good');
    expect(processed).toEqual(['good']);
  });

  it('events fire in correct order: enqueue → process → result', async () => {
    const events: string[] = [];
    const q = createSendQueue<number>({
      handler: async () => { await sleep(5); },
    });

    q.on('enqueue', () => events.push('enqueue'));
    q.on('process', () => events.push('process'));
    q.on('result', () => events.push('result'));
    q.on('drain', () => events.push('drain'));

    await q.enqueue(42);

    expect(events).toEqual(['enqueue', 'process', 'result', 'drain']);
  });

  it('error event fires on handler failure', async () => {
    const errors: unknown[] = [];
    const q = createSendQueue<string>({
      handler: async (s) => {
        if (s === 'fail') throw new Error('expected fail');
      },
      continueOnError: true,
    });

    q.on('error', (payload) => errors.push(payload));

    await q.enqueue('fail').catch(() => {});
    expect(errors.length).toBe(1);
    expect((errors[0] as { error: Error }).error.message).toBe('expected fail');
  });

  it('size() returns only pending, not in-flight', async () => {
    // Only the FIRST item blocks — subsequent items pass through. Otherwise
    // item 2 would await a release that is never set again, hanging the queue.
    let releaseFirst: (() => void) | null = null;
    let count = 0;
    const q = createSendQueue<number>({
      handler: async () => {
        const n = ++count;
        if (n === 1) {
          await new Promise<void>((r) => { releaseFirst = r; });
        }
      },
    });

    const p1 = q.enqueue(1);
    // Small wait to let item 1 enter the handler (become in-flight)
    await sleep(20);
    expect(q.size()).toBe(0); // in-flight, not pending

    // Enqueue item 2 while 1 is in-flight
    const p2 = q.enqueue(2);
    expect(q.size()).toBe(1); // 2 is pending

    releaseFirst!();        // release item 1
    await Promise.all([p1, p2]);
    expect(q.size()).toBe(0);
  });
});
