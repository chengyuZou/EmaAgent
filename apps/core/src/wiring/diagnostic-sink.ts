/**
 * diagnostic-sink.ts — HookBus trace → 后端诊断
 *
 * 1. 环形缓冲：内存保留最近 200 条 trace，设置页可一键导出
 * 2. 控制台：失败记录写入 stderr
 *
 * 用户可见的结构化 hook_warning 由 HookBus 通过每个 Turn 的 ctx.emit
 * 发出。这里没有全局 SSE emitter，避免并发 Turn 的诊断串流。
 */

import type { HookTraceEntry } from '@ema-agent/hook';

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
 * 创建捕获每次 handler 执行结果的后端 trace sink。
 */
export function createTraceSink(): (entry: HookTraceEntry) => void {
  return (entry: HookTraceEntry) => {
    pushRing(entry);

    if (entry.result === 'error' || entry.result === 'abort') {
      console.error(`[hook] ${entry.sessionId}/${entry.turnId} ${entry.event} ${entry.handlerName} ${entry.durationMs.toFixed(1)}ms ${entry.result} — ${entry.reason ?? ''}`);
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
