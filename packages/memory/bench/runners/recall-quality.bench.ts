/**
 * recall-quality.bench.ts — Precision / Recall / F1 / MRR / Hit@1
 *
 * Three retrievers evaluated against the same oracle fixture:
 *
 *   1. Random     — shuffle & slice.  Establishes absolute floor.
 *   2. BM25       — keyword retrieval (no API, no deps).  Realistic lower bound.
 *                   Anything below BM25 means our system is WORSE than a search
 *                   engine — embarrassing.  Target: MemoryPlanner >> BM25.
 *   3. MemoryPlanner (stub) — requires full MemoryDeps; prints setup instructions
 *                   when not wired.  Wire it by implementing `MemoryPlannerAdapter`
 *                   at the bottom of this file.
 *
 * Output:
 *   - Console table (human readable)
 *   - bench/bench-results/recall-quality.json  (CI baseline comparison)
 *
 * Usage:
 *   npx tsx packages/memory/bench/runners/recall-quality.bench.ts
 *   npx tsx packages/memory/bench/runners/recall-quality.bench.ts --k 10
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

function getFixturePath(defaultName: string): string {
  const arg = process.argv.find(a => a.startsWith('--fixture='));
  if (!arg) return path.resolve(__dir, '../fixtures', defaultName);
  const val = arg.split('=').slice(1).join('=');
  return path.isAbsolute(val) ? val : path.resolve(__dir, '../fixtures', val);
}

const FIXTURE_PATH = getFixturePath('chat-oracle.json');
const RESULTS_DIR  = path.resolve(__dir, '../bench-results');
const RESULTS_PATH = path.resolve(RESULTS_DIR, 'recall-quality.json');

// TOP_K: how many messages the retriever returns.
// Matches MemoryPlanner default layer2TopK = 6.
const TOP_K = (() => {
  const arg = process.argv.find(a => a.startsWith('--k=') || a === '--k');
  if (!arg) return 6;
  const next = process.argv[process.argv.indexOf(arg) + 1];
  const val  = arg.startsWith('--k=') ? arg.split('=')[1] : next;
  return val ? parseInt(val, 10) : 6;
})();

// ── Fixture types ─────────────────────────────────────────────────────────────

interface BenchMessage {
  sessionIdx: number;
  msgIdx:     number;
  role:       'user' | 'assistant';
  content:    string;
  isEvidence: boolean;
}

interface BenchCase {
  id:                  string;
  questionType:        string;
  query:               string;
  groundTruth:         string;
  messages:            BenchMessage[];
  relevantMessageIds:  string[];
  evidenceCount:       number;
  totalMessages:       number;
}

interface BenchFixture {
  meta:  { source: string; generatedAt: string; totalCases: number };
  cases: BenchCase[];
}

// ── Metrics types ─────────────────────────────────────────────────────────────

interface QMetrics {
  precision: number;
  recall:    number;
  f1:        number;
  mrr:       number;
  hitAt1:    number;
}

interface RunResult {
  retriever:  string;
  topK:       number;
  overall:    QMetrics;
  byType:     Record<string, QMetrics>;
  n:          number;
  durationMs: number;
}

// ── Core metric computation ───────────────────────────────────────────────────

function computeMetrics(relevant: Set<string>, retrieved: string[]): QMetrics {
  let tp         = 0;
  let firstRank  = -1;

  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i]!)) {
      tp++;
      if (firstRank === -1) firstRank = i + 1;
    }
  }

  const k         = retrieved.length;
  const precision = k > 0           ? tp / k              : 0;
  const recall    = relevant.size > 0 ? tp / relevant.size : 0;
  const f1        = precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;
  const mrr       = firstRank > 0 ? 1 / firstRank : 0;
  const hitAt1    = k > 0 && relevant.has(retrieved[0]!) ? 1 : 0;

  return { precision, recall, f1, mrr, hitAt1 };
}

function avgMetrics(ms: QMetrics[]): QMetrics {
  const n = ms.length;
  if (n === 0) return { precision: 0, recall: 0, f1: 0, mrr: 0, hitAt1: 0 };
  const s = (k: keyof QMetrics) => ms.reduce((a, m) => a + m[k], 0);
  return {
    precision: s('precision') / n,
    recall:    s('recall')    / n,
    f1:        s('f1')        / n,
    mrr:       s('mrr')       / n,
    hitAt1:    s('hitAt1')    / n,
  };
}

function aggregateRun(
  retrieverName: string,
  cases: BenchCase[],
  retrieve: (c: BenchCase) => string[],
  topK: number,
): RunResult {
  const t0 = Date.now();
  const all: QMetrics[] = [];
  const byType: Record<string, QMetrics[]> = {};

  for (const c of cases) {
    const relevant  = new Set(c.relevantMessageIds);
    const retrieved = retrieve(c);
    const m         = computeMetrics(relevant, retrieved);
    all.push(m);
    (byType[c.questionType] ??= []).push(m);
  }

  return {
    retriever:  retrieverName,
    topK,
    n:          cases.length,
    durationMs: Date.now() - t0,
    overall:    avgMetrics(all),
    byType:     Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, avgMetrics(v)]),
    ),
  };
}

// ── Retriever 1: Random ───────────────────────────────────────────────────────

function randomRetrieve(c: BenchCase, k: number): string[] {
  return [...c.messages]
    .sort(() => Math.random() - 0.5)
    .slice(0, k)
    .map(m => `${m.sessionIdx}_${m.msgIdx}`);
}

// ── Retriever 2: BM25 ─────────────────────────────────────────────────────────
//
// Pure in-memory BM25 — no external dependencies.
// Tokenises to lowercase alphanumeric tokens (len ≥ 2).
// Tuning: k1 = 1.5, b = 0.75 (Robertson & Zaragoza defaults).
//
// Why BM25 matters as a baseline:
//   Any embedding-based or graph-based system MUST beat BM25 to justify
//   its operational cost.  If MemoryPlanner F1 ≤ BM25 F1, the vector index
//   is adding noise, not signal — fix the extraction pipeline first.

class BM25Lite {
  private idf:   Map<string, number> = new Map();
  private docs:  Array<{ id: string; tokens: string[]; len: number }> = [];
  private avgdl = 0;

  private static tokenize(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  }

  /** Index a collection of documents.  Call once per case. */
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
      // Robertson-Sparck Jones IDF (with +1 smoothing to avoid log(0))
      this.idf.set(term, Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1));
    }
  }

  /** Return top-k document ids ranked by BM25 score. */
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

function bm25Retrieve(c: BenchCase, k: number): string[] {
  const bm25 = new BM25Lite();
  // Index user messages only — that's where factual evidence lives.
  // Assistant messages in the oracle data are generic "I'm an AI" responses
  // that dilute signal without helping recall.
  const docs = c.messages
    .filter(m => m.role === 'user')
    .map(m => ({
      id:   `${m.sessionIdx}_${m.msgIdx}`,
      text: m.content,
    }));
  bm25.fit(docs);
  return bm25.query(c.query, k);
}

// ── Retriever 3: MemoryPlanner ────────────────────────────────────────────────
//
// The real planner integration lives in planner-recall.bench.ts which:
//   - Creates per-case in-memory SQLite DBs with a mock EmbedRuntime (bench-deps.ts)
//   - Inserts extracted items (from DeepSeek cache) with BGE-M3 embeddings
//   - Calls MemoryPlanner.initialize() then plan() and evaluates the RecallBundle
//
// Results (full 467-case run):
//   Answer Hit Rate  69.0%  — matches cosine-only extracted-recall exactly
//   Hit@1            56.3%  — single-hop 87.8%, temporal 61.7%, multi 52.6%
//   MRR              0.618
//
// This runner evaluates raw message retrieval (BM25) only — use
//   npx tsx bench/runners/planner-recall.bench.ts
// for the production planner path.

const MEMORY_PLANNER_WIRED = false;

function memoryPlannerRetrieve(_c: BenchCase, _k: number): string[] {
  throw new Error('Use planner-recall.bench.ts for MemoryPlanner evaluation');
}

// ── Output helpers ────────────────────────────────────────────────────────────

const COL = { type: 20, f1: 7, recall: 8, prec: 7, mrr: 7, hit1: 7 };
const SEP  = '─'.repeat(COL.type + COL.f1 + COL.recall + COL.prec + COL.mrr + COL.hit1 + 12);

function fmtN(v: number, w = 7): string {
  return v.toFixed(3).padStart(w);
}

function printResult(result: RunResult): void {
  const badge = result.durationMs < 1000
    ? `${result.durationMs}ms`
    : `${(result.durationMs / 1000).toFixed(1)}s`;

  console.log(`\n┌─ ${result.retriever.toUpperCase()} ─── n=${result.n} · k=${result.topK} · ${badge}`);
  console.log(
    `│ ${'Type'.padEnd(COL.type)} ${'F1'.padStart(COL.f1)} ${'Recall'.padStart(COL.recall)}` +
    ` ${'Prec'.padStart(COL.prec)} ${'MRR'.padStart(COL.mrr)} ${'Hit@1'.padStart(COL.hit1)}`,
  );
  console.log(`│ ${SEP}`);

  const printRow = (label: string, m: QMetrics) => {
    console.log(
      `│ ${label.padEnd(COL.type)}` +
      ` ${fmtN(m.f1, COL.f1)} ${fmtN(m.recall, COL.recall)}` +
      ` ${fmtN(m.precision, COL.prec)} ${fmtN(m.mrr, COL.mrr)} ${fmtN(m.hitAt1, COL.hit1)}`,
    );
  };

  printRow('OVERALL', result.overall);
  console.log(`│ ${'─'.repeat(SEP.length)}`);
  for (const [type, m] of Object.entries(result.byType)) printRow(type, m);
  console.log('└');
}

function printDelta(base: RunResult, target: RunResult): void {
  const pct = (a: number, b: number) => {
    const d = ((b - a) / Math.max(a, 1e-9)) * 100;
    const s = d >= 0 ? `+${d.toFixed(1)}%` : `${d.toFixed(1)}%`;
    return (d >= 0 ? '▲' : '▼') + s;
  };
  console.log(
    `  Δ vs ${base.retriever}: ` +
    `F1 ${pct(base.overall.f1, target.overall.f1)}  ` +
    `Recall ${pct(base.overall.recall, target.overall.recall)}  ` +
    `MRR ${pct(base.overall.mrr, target.overall.mrr)}`,
  );
}

// ── Results JSON ──────────────────────────────────────────────────────────────

function saveResults(results: RunResult[]): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = {
    generatedAt: new Date().toISOString(),
    topK:        TOP_K,
    results,
  };
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`\n[bench] Results saved → ${RESULTS_PATH}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  console.log(`[recall-quality] Loading fixture …`);
  if (!fs.existsSync(FIXTURE_PATH)) {
    console.error(`[recall-quality] fixture not found: ${FIXTURE_PATH}`);
    console.error(`[recall-quality] Run: npx tsx bench/scripts/convert-oracle.ts`);
    process.exit(1);
  }

  const fixture: BenchFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  const cases = fixture.cases;
  console.log(`[recall-quality] ${cases.length} cases loaded · TOP_K=${TOP_K}`);

  const results: RunResult[] = [];

  // ── 1. Random baseline ─────────────────────────────────────────────────────
  console.log('\n[recall-quality] Running: Random …');
  const randomResult = aggregateRun(
    'random',
    cases,
    c => randomRetrieve(c, TOP_K),
    TOP_K,
  );
  results.push(randomResult);
  printResult(randomResult);

  // ── 2. BM25 baseline ──────────────────────────────────────────────────────
  console.log('\n[recall-quality] Running: BM25 …');
  const bm25Result = aggregateRun(
    'bm25',
    cases,
    c => bm25Retrieve(c, TOP_K),
    TOP_K,
  );
  results.push(bm25Result);
  printResult(bm25Result);
  printDelta(randomResult, bm25Result);

  // ── 3. MemoryPlanner ─────────────────────────────────────────────────────
  if (MEMORY_PLANNER_WIRED) {
    console.log('\n[recall-quality] Running: MemoryPlanner …');
    const mpResult = aggregateRun(
      'memory_planner',
      cases,
      c => memoryPlannerRetrieve(c, TOP_K),
      TOP_K,
    );
    results.push(mpResult);
    printResult(mpResult);
    printDelta(randomResult, mpResult);
    printDelta(bm25Result,   mpResult);
  } else {
    console.log('\n[recall-quality] MemoryPlanner: NOT WIRED (skipped)');
    console.log('  To wire: implement `memoryPlannerRetrieve()` in this file.');
    console.log('  See comment block near "Retriever 3" for setup instructions.');
    console.log(`  Target goals: F1 ≥ 0.75 · Recall ≥ 0.80 (vs BM25 F1 ${bm25Result.overall.f1.toFixed(3)})`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n═══ SUMMARY ═══════════════════════════════════════════════════');
  console.log(`${'Retriever'.padEnd(18)} ${'F1'.padStart(7)} ${'Recall'.padStart(8)} ${'MRR'.padStart(7)} ${'Hit@1'.padStart(7)}`);
  console.log('─'.repeat(50));
  for (const r of results) {
    console.log(
      `${r.retriever.padEnd(18)}` +
      ` ${fmtN(r.overall.f1)} ${fmtN(r.overall.recall, 8)}` +
      ` ${fmtN(r.overall.mrr)} ${fmtN(r.overall.hitAt1)}`,
    );
  }
  if (!MEMORY_PLANNER_WIRED) {
    console.log(`${'memory_planner'.padEnd(18)} ${'(not wired)'.padStart(34)}`);
  }
  console.log(`\nTarget: F1 ≥ 0.750 · Recall ≥ 0.800`);

  saveResults(results);
}

main();
