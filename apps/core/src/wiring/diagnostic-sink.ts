/**
 * diagnostic-sink.ts — HookBus trace → 三层自动诊断
 *
 * Layer 1 (即时可见): emit system_warning SSE for errored/aborted handlers
 * Layer 2 (环形缓冲): 内存保留最近 200 条 trace，设置页可一键导出
 * Layer 3 (控制台): 结构化 JSON 写入 stderr，grep 友好
 *
 * Usage in bindings.ts:
 *   const hooks = new HookBus({
 *     traceSink: createTraceSink(emit),
 *     warnAnonymous: process.env['NODE_ENV'] !== 'production',
 *   });
 *
 * Then in a diagnostic route:
 *   import { getDiagnostics } from './wiring/diagnostic-sink.js';
 *   app.get('/api/diagnostics/hooks', (c) => c.json(getDiagnostics()));
 */

import type { HookTraceEntry } from '@ema-agent/hook';
import type { EmaStreamEvent } from '@ema-agent/contracts';

// ── Ring buffer ──────────────────────────────────────────────────────────────

const RING_SIZE = 200;

const ring: HookTraceEntry[] = [];
let ringIdx = 0;

function pushRing(entry: HookTraceEntry): void {
  ring[ringIdx % RING_SIZE] = entry;
  ringIdx++;
}

// ── Sink factory ─────────────────────────────────────────────────────────────

/**
 * Create a `traceSink` that captures every handler execution and optionally
 * emits user-visible warnings for slow / errored handlers.
 *
 * @param emit  SSE emitter — if missing, Layer 1 (user-visible warning) is skipped.
 *              The ring buffer and console logging always run regardless.
 */
export function createTraceSink(
  emit?: (ev: EmaStreamEvent) => void,
): (entry: HookTraceEntry) => void {
  return (entry: HookTraceEntry) => {
    // ── Layer 2: ring buffer (always on) ─────────────────────────────────
    pushRing(entry);

    // ── Layer 3: structured console log (only on error/abort — no duration threshold) ──
    if (entry.result === 'error' || entry.result === 'abort') {
      console.error(`[hook] ${entry.event} ${entry.handlerName} ${entry.durationMs.toFixed(1)}ms ${entry.result} — ${entry.reason ?? ''}`);
    }

    // ── Layer 1: SSE user-visible warning (only on error/abort — no duration threshold) ──
    if (!emit) return;

    if (entry.result === 'error' || entry.result === 'abort') {
      emit({
        type:    'system_warning',
        level:   'error',
        message: `Hook ${entry.handlerName} (${entry.event}) ${entry.result}: ${entry.reason ?? 'unknown'}`,
      });
    }
  };
}

// ── Diagnostics export ───────────────────────────────────────────────────────

export interface HookDiagnostics {
  /** Most recent traces in chronological order (up to RING_SIZE). */
  traces:          HookTraceEntry[];
  /** Total traces captured since startup. */
  totalCaptured:   number;
  /** Counts by result kind. */
  summary: {
    continue: number;
    replace:  number;
    abort:    number;
    error:    number;
  };
  /** Handlers that errored or aborted, newest first. */
  failures:        HookTraceEntry[];
  /** Top 5 slowest successful handlers. */
  slowest:         HookTraceEntry[];
}

export function getDiagnostics(): HookDiagnostics {
  // Reconstruct chronological order from the ring buffer
  const traces: HookTraceEntry[] = [];
  const start = Math.max(0, ringIdx - RING_SIZE);
  for (let i = start; i < ringIdx; i++) {
    const e = ring[i % RING_SIZE];
    if (e) traces.push(e);
  }

  const summary = { continue: 0, replace: 0, abort: 0, error: 0 };
  const failures: HookTraceEntry[] = [];
  for (const t of traces) {
    summary[t.result]++;
    if (t.result === 'abort' || t.result === 'error') failures.push(t);
  }

  const slowest = traces
    .filter(t => t.result === 'continue' || t.result === 'replace')
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);

  return {
    traces,
    totalCaptured: ringIdx,
    summary,
    failures: failures.reverse(),
    slowest,
  };
}
