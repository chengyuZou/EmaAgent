/**
 * latency.bench.ts — BM25 fit + query latency over the oracle fixture.
 *
 * Measures wall-clock time for:
 *   fit      — BM25Lite.fit() for one case's message corpus
 *   query    — BM25Lite.query() for one case
 *   total    — fit + query (end-to-end per-case retrieval latency)
 *
 * Reports: p50 / p95 / p99 / mean in milliseconds.
 *
 * Why BM25 latency matters:
 *   BM25 is the cheapest non-trivial retriever.  If BM25 is already slow,
 *   embedding-based retrieval (which adds a network round-trip) will be
 *   even slower — that informs how aggressively we need to cache vectors.
 *
 * Usage:
 *   npx tsx packages/memory/bench/runners/latency.bench.ts
 *   npx tsx packages/memory/bench/runners/latency.bench.ts --n 200
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_PATH = path.resolve(__dir, '../fixtures/chat-oracle.json');
const RESULTS_DIR  = path.resolve(__dir, '../bench-results');
const RESULTS_PATH = path.resolve(RESULTS_DIR, 'latency.json');

// Number of cases to sample for latency measurement.
// 200 gives stable percentiles without taking too long.
const SAMPLE_N = (() => {
  const arg  = process.argv.find(a => a.startsWith('--n=') || a === '--n');
  const next = arg ? process.argv[process.argv.indexOf(arg) + 1] : undefined;
  const val  = arg?.startsWith('--n=') ? arg.split('=')[1] : next;
  return val ? parseInt(val, 10) : 200;
})();

// ── Fixture types (minimal) ───────────────────────────────────────────────────

interface BenchMessage {
  role:    'user' | 'assistant';
  content: string;
  sessionIdx: number;
  msgIdx:     number;
}

interface BenchCase {
  id:       string;
  query:    string;
  messages: BenchMessage[];
}

interface BenchFixture {
  meta:  { totalCases: number };
  cases: BenchCase[];
}

// ── BM25Lite (same implementation as recall-quality.bench.ts) ─────────────────

class BM25Lite {
  private idf:   Map<string, number> = new Map();
  private docs:  Array<{ id: string; tokens: string[]; len: number }> = [];
  private avgdl = 0;

  private static tokenize(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  }

  fit(documents: Array<{ id: string; text: string }>): void {
    const N  = documents.length;
    const df = new Map<string, number>();

    this.docs = documents.map(d => {
      const tokens = BM25Lite.tokenize(d.text);
      for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
      return { id: d.id, tokens, len: tokens.length };
    });

    this.avgdl = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(N, 1);
    this.idf.clear();
    for (const [term, docFreq] of df) {
      this.idf.set(term, Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1));
    }
  }

  query(text: string, k: number, k1 = 1.5, b = 0.75): string[] {
    const queryTokens = BM25Lite.tokenize(text);
    const scores      = new Map<string, number>();

    for (const doc of this.docs) {
      let   score = 0;
      const tf    = new Map<string, number>();
      for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

      for (const term of queryTokens) {
        const idf = this.idf.get(term);
        if (!idf) continue;
        const f      = tf.get(term) ?? 0;
        const normed = (f * (k1 + 1)) / (f + k1 * (1 - b + b * doc.len / this.avgdl));
        score += idf * normed;
      }

      if (score > 0) scores.set(doc.id, score);
    }

    return [...scores.entries()]
      .sort((a, bv) => bv[1] - a[1])
      .slice(0, k)
      .map(([id]) => id);
  }
}

// ── Percentile helper ─────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

function stats(samples: number[]): {
  mean: number; p50: number; p95: number; p99: number; min: number; max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean   = samples.reduce((s, v) => s + v, 0) / Math.max(samples.length, 1);
  return {
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0]               ?? 0,
    max: sorted[sorted.length-1] ?? 0,
  };
}

// ── Measurement ───────────────────────────────────────────────────────────────

interface LatencyStats {
  mean: number; p50: number; p95: number; p99: number; min: number; max: number;
}

interface LatencyResult {
  retriever: string;
  n:         number;
  fit:       LatencyStats;
  query:     LatencyStats;
  total:     LatencyStats;
  /** Avg number of documents indexed per case (determines fit complexity). */
  avgCorpusSize: number;
}

function measureBm25Latency(cases: BenchCase[], k: number): LatencyResult {
  const fitTimes:   number[] = [];
  const queryTimes: number[] = [];
  const totalTimes: number[] = [];
  let   totalDocs  = 0;

  for (const c of cases) {
    const docs = c.messages
      .filter(m => m.role === 'user')
      .map(m => ({ id: `${m.sessionIdx}_${m.msgIdx}`, text: m.content }));

    totalDocs += docs.length;

    const bm25 = new BM25Lite();

    const t0 = performance.now();
    bm25.fit(docs);
    const t1 = performance.now();
    bm25.query(c.query, k);
    const t2 = performance.now();

    fitTimes.push(t1 - t0);
    queryTimes.push(t2 - t1);
    totalTimes.push(t2 - t0);
  }

  return {
    retriever:    'bm25',
    n:            cases.length,
    fit:          stats(fitTimes),
    query:        stats(queryTimes),
    total:        stats(totalTimes),
    avgCorpusSize: totalDocs / Math.max(cases.length, 1),
  };
}

// ── Output ────────────────────────────────────────────────────────────────────

function fmtMs(v: number): string {
  return v < 1 ? `${(v * 1000).toFixed(0)}µs` : `${v.toFixed(2)}ms`;
}

function printLatency(r: LatencyResult): void {
  const pad = (s: string) => s.padStart(9);
  console.log(`\n┌─ LATENCY: ${r.retriever.toUpperCase()} ─── n=${r.n} · avg_corpus=${r.avgCorpusSize.toFixed(0)} docs`);
  console.log(`│ ${'Stage'.padEnd(8)} ${pad('mean')} ${pad('p50')} ${pad('p95')} ${pad('p99')} ${pad('min')} ${pad('max')}`);
  console.log(`│ ${'─'.repeat(66)}`);

  const row = (label: string, s: LatencyStats) =>
    console.log(
      `│ ${label.padEnd(8)}` +
      ` ${pad(fmtMs(s.mean))} ${pad(fmtMs(s.p50))}` +
      ` ${pad(fmtMs(s.p95))} ${pad(fmtMs(s.p99))}` +
      ` ${pad(fmtMs(s.min))} ${pad(fmtMs(s.max))}`,
    );

  row('fit',   r.fit);
  row('query', r.query);
  row('TOTAL', r.total);
  console.log('└');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  console.log('[latency] Loading fixture …');
  if (!fs.existsSync(FIXTURE_PATH)) {
    console.error(`[latency] fixture not found: ${FIXTURE_PATH}`);
    console.error('[latency] Run: npx tsx bench/scripts/convert-oracle.ts');
    process.exit(1);
  }

  const fixture: BenchFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  const allCases = fixture.cases;

  // Sample randomly without replacement
  const shuffled = [...allCases].sort(() => Math.random() - 0.5);
  const cases    = shuffled.slice(0, Math.min(SAMPLE_N, shuffled.length));

  console.log(`[latency] ${cases.length} cases sampled (of ${allCases.length}) · k=6`);

  const bm25Result = measureBm25Latency(cases, 6);
  printLatency(bm25Result);

  // Thresholds guidance
  console.log('Thresholds (MemoryPlanner target):');
  console.log('  BM25 total  p95 < 5ms   (fast path reference point)');
  console.log('  Embedding   p95 < 150ms (round-trip to ebd-client)');
  console.log('  Full plan() p95 < 200ms (BM25 + embed + graph)');

  // Save
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    RESULTS_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), results: [bm25Result] }, null, 2),
    'utf-8',
  );
  console.log(`\n[latency] Results saved → ${RESULTS_PATH}`);
}

main();
