/* eslint-disable no-console */
//
// Vector recall benchmark.
//
// Compares the old approach (raw vectors + full cosine-sim per pair) against
// the new approach (pre-normalized vectors + dot product). Reports per-query
// latency and process memory at several N scales.
//
// Run:
//   node --max-old-space-size=8192 packages/memory/bench/vector-perf.ts <maxN>
// (optional max N override; default 1_000_000)

import { performance } from 'node:perf_hooks';

// ── Implementations being benchmarked ────────────────────────────────────────

/** Old cosine similarity — computes both norms + sqrt per pair. */
function legacyCosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot   += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** New dot product — assumes both vectors are pre-normalized. */
function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function normalize(vec: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i]! * vec[i]!;
  if (s === 0) return vec;
  const inv = 1 / Math.sqrt(s);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! * inv;
  return out;
}

// ── Data generation ─────────────────────────────────────────────────────────

const DIM = 1536;

function randomVec(): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.random() * 2 - 1;
  return v;
}

// Flat storage layout: one big Float32Array of N * DIM. This is the cache-
// friendliest layout — corresponds to what `usearch` does internally.
function generateFlat(n: number): Float32Array {
  const flat = new Float32Array(n * DIM);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < DIM; j++) {
      flat[i * DIM + j] = Math.random() * 2 - 1;
    }
  }
  return flat;
}

function normalizeFlat(flat: Float32Array, n: number): Float32Array {
  const out = new Float32Array(flat.length);
  for (let i = 0; i < n; i++) {
    const base = i * DIM;
    let s = 0;
    for (let j = 0; j < DIM; j++) s += flat[base + j]! * flat[base + j]!;
    const inv = s === 0 ? 0 : 1 / Math.sqrt(s);
    for (let j = 0; j < DIM; j++) out[base + j] = flat[base + j]! * inv;
  }
  return out;
}

// ── Top-K search (running heap, k small) ────────────────────────────────────

function topKLegacy(flat: Float32Array, n: number, query: Float32Array, k: number): number {
  const top: { idx: number; score: number }[] = [];
  let worst = -Infinity;
  // Wrap each row into a view so legacyCosineSim sees a Float32Array
  const view = new Float32Array(DIM);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < DIM; j++) view[j] = flat[i * DIM + j]!;
    const s = legacyCosineSim(query, view);
    if (top.length < k) {
      top.push({ idx: i, score: s });
      if (top.length === k) {
        top.sort((a, b) => a.score - b.score);
        worst = top[0]!.score;
      }
      continue;
    }
    if (s <= worst) continue;
    top[0] = { idx: i, score: s };
    top.sort((a, b) => a.score - b.score);
    worst = top[0]!.score;
  }
  return top[k - 1]!.score;
}

function topKDot(flat: Float32Array, n: number, query: Float32Array, k: number): number {
  const top: { idx: number; score: number }[] = [];
  let worst = -Infinity;
  for (let i = 0; i < n; i++) {
    const base = i * DIM;
    // Inline dot product — no view allocation per row
    let s = 0;
    for (let j = 0; j < DIM; j++) s += query[j]! * flat[base + j]!;
    if (top.length < k) {
      top.push({ idx: i, score: s });
      if (top.length === k) {
        top.sort((a, b) => a.score - b.score);
        worst = top[0]!.score;
      }
      continue;
    }
    if (s <= worst) continue;
    top[0] = { idx: i, score: s };
    top.sort((a, b) => a.score - b.score);
    worst = top[0]!.score;
  }
  return top[k - 1]!.score;
}

// ── Memory snapshot ─────────────────────────────────────────────────────────

function snapshot(): string {
  const m = process.memoryUsage();
  const fmt = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `rss=${fmt(m.rss)} heap=${fmt(m.heapUsed)}/${fmt(m.heapTotal)} ext=${fmt(m.external)}`;
}

// ── Runner ──────────────────────────────────────────────────────────────────

interface Sample {
  n: number;
  legacyMs: number;
  dotMs: number;
  speedup: number;
  memBefore: string;
  memAfter: string;
}

async function runScale(n: number, queries: number): Promise<Sample> {
  console.log(`\n── N = ${n.toLocaleString()} ── ${snapshot()}`);

  // Generate once, run legacy, normalize in-place, run dot. Keeps peak memory
  // at one copy of the flat buffer (~6 GB for 1M × 1536 × 4B).
  console.log('  generating data…');
  const tGen0 = performance.now();
  const flat = generateFlat(n);
  console.log(`    raw    : ${((performance.now() - tGen0) / 1000).toFixed(1)}s  ${snapshot()}`);

  const memBefore = snapshot();

  // ── Warmup (legacy on raw) ────────────────────────────────────────────────
  topKLegacy(flat, n, randomVec(), 10);

  // ── Legacy benchmark ──────────────────────────────────────────────────────
  console.log('  running legacy cosine-sim search…');
  const legacyTimes: number[] = [];
  for (let q = 0; q < queries; q++) {
    const query = randomVec();
    const t = performance.now();
    topKLegacy(flat, n, query, 10);
    legacyTimes.push(performance.now() - t);
  }
  const legacyAvg = legacyTimes.reduce((a, b) => a + b, 0) / legacyTimes.length;
  console.log(`    avg = ${legacyAvg.toFixed(1)} ms  min = ${Math.min(...legacyTimes).toFixed(1)} ms  max = ${Math.max(...legacyTimes).toFixed(1)} ms`);

  // ── Normalize in-place ────────────────────────────────────────────────────
  console.log('  normalizing in-place…');
  const tNorm = performance.now();
  for (let i = 0; i < n; i++) {
    const base = i * DIM;
    let s = 0;
    for (let j = 0; j < DIM; j++) s += flat[base + j]! * flat[base + j]!;
    const inv = s === 0 ? 0 : 1 / Math.sqrt(s);
    for (let j = 0; j < DIM; j++) flat[base + j] *= inv;
  }
  console.log(`    done   : ${((performance.now() - tNorm) / 1000).toFixed(1)}s  ${snapshot()}`);

  // ── Dot-product benchmark ─────────────────────────────────────────────────
  console.log('  running dot-product search…');
  const dotTimes: number[] = [];
  for (let q = 0; q < queries; q++) {
    const query = normalize(randomVec());
    const t = performance.now();
    topKDot(flat, n, query, 10);
    dotTimes.push(performance.now() - t);
  }
  const dotAvg = dotTimes.reduce((a, b) => a + b, 0) / dotTimes.length;
  console.log(`    avg = ${dotAvg.toFixed(1)} ms  min = ${Math.min(...dotTimes).toFixed(1)} ms  max = ${Math.max(...dotTimes).toFixed(1)} ms`);

  const memAfter = snapshot();
  const speedup = legacyAvg / dotAvg;
  console.log(`  speedup: ${speedup.toFixed(2)}×`);

  // Suppress unused-variable lint on the in-place mutated buffer view
  void flat;

  return { n, legacyMs: legacyAvg, dotMs: dotAvg, speedup, memBefore, memAfter };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const maxArg = Number(process.argv[2] ?? '1000000');
  const scales = [10_000, 100_000, 500_000, 1_000_000].filter(n => n <= maxArg);

  console.log(`Vector benchmark — dim=${DIM}, k=10, top-K search`);
  console.log(`Heap limit: ~${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(0)} MB initial`);
  console.log(`Scales: ${scales.map(n => n.toLocaleString()).join(', ')}`);

  const results: Sample[] = [];
  for (const n of scales) {
    try {
      const r = await runScale(n, n >= 500_000 ? 3 : 5);
      results.push(r);
      // Force GC between scales if we have it
      const g = (globalThis as unknown as { gc?: () => void }).gc;
      if (g) g();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ failed at N=${n}: ${msg}`);
      break;
    }
  }

  console.log('\n┌─────────────┬─────────────┬─────────────┬──────────┐');
  console.log('│ N           │ Legacy (ms) │ Dot   (ms)  │ Speedup  │');
  console.log('├─────────────┼─────────────┼─────────────┼──────────┤');
  for (const r of results) {
    console.log(
      `│ ${r.n.toLocaleString().padStart(11)} │ ${r.legacyMs.toFixed(1).padStart(11)} │ ${r.dotMs.toFixed(1).padStart(11)} │ ${(r.speedup.toFixed(2) + '×').padStart(8)} │`,
    );
  }
  console.log('└─────────────┴─────────────┴─────────────┴──────────┘');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
