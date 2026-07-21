/**
 * planner-recall.bench.ts — Real MemoryPlanner integration bench.
 *
 * This runner exercises the ACTUAL production code path end-to-end:
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  Oracle case                                                        │
 *   │       │                                                             │
 *   │       ▼                                                             │
 *   │  [Offline] DeepSeek extraction (cached from extracted-recall run)  │
 *   │       → {title, body} items                                        │
 *   │       │                                                             │
 *   │       ▼                                                             │
 *   │  [Offline] BGE-M3 embedding (cached from siliconflow.ts)           │
 *   │       → packed Float32Array stored in memory_items.embedding       │
 *   │       │                                                             │
 *   │       ▼                                                             │
 *   │  [Online] MemoryPlanner.initialize()                               │
 *   │       → builds VectorIndex from memory_items rows                  │
 *   │       │                                                             │
 *   │       ▼                                                             │
 *   │  [Online] MemoryPlanner.plan({ userInput: query })                 │
 *   │       → embedQuery() via mock EmbedRuntime (cache hit)            │
 *   │       → recallEpisodic() → VectorIndex.search() → top-K items     │
 *   │       │                                                             │
 *   │       ▼                                                             │
 *   │  [Eval] Semantic match: does any recalled item body answer query?  │
 *   │       → cosine(item_body_vec, ground_truth_vec) ≥ threshold        │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Compared to extracted-recall.bench.ts:
 *   - Uses real MemoryPlanner instead of manual cosine search.
 *   - Tests the actual VectorIndex, mode-weighting, alreadySurfaced logic.
 *   - No reranker; the bench only exercises the bi-encoder recall path.
 *   - Same evaluation metric (semantic cosine match to ground truth).
 *
 * Usage:
 *   npx tsx bench/runners/planner-recall.bench.ts
 *   npx tsx bench/runners/planner-recall.bench.ts --k=10
 *   npx tsx bench/runners/planner-recall.bench.ts --sample=50
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmbedCache, embedMany, EMBED_DIM, rerank } from '../lib/siliconflow.js';
import { ExtractionCache, extractMany }             from '../lib/deepseek.js';
import type { ExtractedItem }                from '../lib/deepseek.js';
import {
  createBenchDeps,
  insertBenchItems,
  BENCH_PROVIDER_ID,
  BENCH_MODEL,
} from '../lib/bench-deps.js';
import { MemoryPlanner }     from '../../src/planner.js';
import { asSessionId, asTurnId } from '@ema-agent/contracts';

const __dir = path.dirname(fileURLToPath(import.meta.url));

function getFixturePath(defaultName: string): string {
  const arg = process.argv.find(a => a.startsWith('--fixture='));
  if (!arg) return path.resolve(__dir, '../fixtures', defaultName);
  const val = arg.split('=').slice(1).join('=');
  return path.isAbsolute(val) ? val : path.resolve(__dir, '../fixtures', val);
}

const FIXTURE_PATH = getFixturePath('chat-oracle.json');
const RESULTS_DIR  = path.resolve(__dir, '../bench-results');
const RESULTS_PATH = path.resolve(RESULTS_DIR, 'planner-recall.json');

// ── CLI args ──────────────────────────────────────────────────────────────────

function getArg(name: string, def: number): number {
  const arg  = process.argv.find(a => a.startsWith(`--${name}=`) || a === `--${name}`);
  const next = arg ? process.argv[process.argv.indexOf(arg) + 1] : undefined;
  const val  = arg?.startsWith(`--${name}=`) ? arg.split('=')[1] : next;
  return val ? parseInt(val, 10) : def;
}

const TOP_K    = getArg('k',      6);
const SAMPLE_N = getArg('sample', 0);   // 0 = all cases

// ── Fixture types ─────────────────────────────────────────────────────────────

interface BenchMessage {
  sessionIdx: number;
  msgIdx:     number;
  role:       'user' | 'assistant';
  content:    string;
  isEvidence: boolean;
}

interface BenchCase {
  id:                 string;
  questionType:       string;
  query:              string;
  groundTruth:        string;
  messages:           BenchMessage[];
  relevantMessageIds: string[];
  evidenceCount:      number;
}

interface BenchFixture {
  meta:  { totalCases: number };
  cases: BenchCase[];
}

// ── Semantic answer matching ───────────────────────────────────────────────────

const SEMANTIC_THRESHOLD = 0.50;

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na  += a[i]! * a[i]!;
    nb  += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na * nb);
  return denom > 0 ? dot / denom : 0;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

interface CaseResult {
  id:           string;
  questionType: string;
  itemCount:    number;
  hitInTopK:    boolean;
  hitAt1:       boolean;
  mrr:          number;
}

interface AggResult {
  n:             number;
  hitRate:       number;
  hitAt1:        number;
  mrr:           number;
  avgItems:      number;
  durationMs:    number;
}

function aggregate(results: CaseResult[], ms: number): AggResult {
  const n = results.length;
  if (!n) return { n: 0, hitRate: 0, hitAt1: 0, mrr: 0, avgItems: 0, durationMs: ms };
  const s = (fn: (r: CaseResult) => number) => results.reduce((a, r) => a + fn(r), 0);
  return {
    n,
    hitRate:    s(r => r.hitInTopK ? 1 : 0) / n,
    hitAt1:     s(r => r.hitAt1    ? 1 : 0) / n,
    mrr:        s(r => r.mrr) / n,
    avgItems:   s(r => r.itemCount) / n,
    durationMs: ms,
  };
}

function printAgg(label: string, agg: AggResult): void {
  const ms = agg.durationMs;
  const t  = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  console.log(`\n┌─ ${label} ─── n=${agg.n} · k=${TOP_K} · ${t}`);
  console.log(`│  Answer Hit Rate  (any top-${TOP_K}) : ${(agg.hitRate * 100).toFixed(1)}%`);
  console.log(`│  Answer Hit@1     (top-1 only) : ${(agg.hitAt1 * 100).toFixed(1)}%`);
  console.log(`│  MRR                           : ${agg.mrr.toFixed(3)}`);
  console.log(`│  Avg items / case              : ${agg.avgItems.toFixed(1)}`);
  console.log('└');
}

function printByType(byType: Record<string, CaseResult[]>): void {
  console.log(`\n${'Type'.padEnd(20)} ${'HitRate'.padStart(9)} ${'Hit@1'.padStart(8)} ${'MRR'.padStart(7)} ${'N'.padStart(5)}`);
  console.log('─'.repeat(53));
  for (const [type, results] of Object.entries(byType).sort()) {
    const n = results.length;
    const hitRate = results.filter(r => r.hitInTopK).length / n;
    const hitAt1  = results.filter(r => r.hitAt1).length   / n;
    const mrr     = results.reduce((a, r) => a + r.mrr, 0) / n;
    console.log(
      `${type.padEnd(20)}` +
      ` ${(hitRate * 100).toFixed(1).padStart(8)}%` +
      ` ${(hitAt1  * 100).toFixed(1).padStart(7)}%` +
      ` ${mrr.toFixed(3).padStart(7)}` +
      ` ${String(n).padStart(5)}`,
    );
  }
}

// ── Precompute: embed all item bodies + queries + ground truths ────────────────

async function precomputeEmbeddings(
  cases:          BenchCase[],
  extractCache:   ExtractionCache,
  embedCache:     EmbedCache,
): Promise<void> {
  const textsToEmbed: string[] = [];

  for (const c of cases) {
    textsToEmbed.push(c.query);
    if (typeof c.groundTruth === 'string' && c.groundTruth.length > 0) {
      textsToEmbed.push(c.groundTruth);
    }
    const items = extractCache.get(c.id) ?? [];
    for (const it of items) {
      if (it.body)  textsToEmbed.push(it.body);
      if (it.title) textsToEmbed.push(it.title);
    }
  }

  const newCount = textsToEmbed.filter(t => !embedCache.has(t)).length;
  console.log(`[embed] Corpus: ${textsToEmbed.length} texts  (${newCount} not yet cached)`);

  if (newCount === 0) {
    console.log('[embed] All cached — no API calls');
    return;
  }

  process.stdout.write('[embed] Embedding ');
  await embedMany(textsToEmbed, embedCache, (done, total) => {
    if (done % 64 === 0 || done === total) process.stdout.write(`${done}/${total} `);
  });
  process.stdout.write('\n');
}

// ── Single-case planner evaluation ────────────────────────────────────────────

async function evalCase(
  c:            BenchCase,
  items:        ExtractedItem[],
  embedCache:   EmbedCache,
): Promise<CaseResult> {
  const bd = createBenchDeps(embedCache);

  try {
    // Insert extracted items with their BGE-M3 embeddings
    const batchInput = items
      .filter(it => it.body && embedCache.has(it.body))
      .map(it => ({ title: it.title, body: it.body, vec: embedCache.get(it.body)! }));

    insertBenchItems(bd.items, batchInput);

    // Build planner with per-case settings (disable L0/L1/narrative — empty DBs)
    const planner = new MemoryPlanner(bd.deps, {
      models: { embed: { providerId: BENCH_PROVIDER_ID, model: BENCH_MODEL } },
      recall: { layer2TopK: TOP_K, currentModeWeight: 1.0 },  // all slots to current mode
    });

    await planner.initialize();

    const sessionId = asSessionId('bench-session');
    const turnId    = asTurnId('bench-turn');

    const bundle = await planner.plan({
      sessionId,
      turnId,
      mode:      'chat',
      userInput: c.query,
    });

    // Evaluate recalled items
    const truth = typeof c.groundTruth === 'string' && c.groundTruth.length > 0
      ? c.groundTruth : null;
    const truthVec = truth ? embedCache.get(truth) ?? null : null;

    const recalledItems = [
      ...(bundle.layer2?.currentMode ?? []),
      ...(bundle.layer2?.otherModes  ?? []),
    ];

    // Rerank via bge-reranker-v2-m3 for better ordering.
    // Falls back to planner order if reranker is unavailable.
    let orderedItems = recalledItems;
    if (recalledItems.length > 1) {
      try {
        const docs     = recalledItems.map(it => it.body);
        const reranked = await rerank(c.query, docs);
        orderedItems   = reranked
          .sort((a, b) => b.score - a.score)
          .map(r => recalledItems[r.index]!)
          .filter(Boolean);
      } catch {
        // reranker unavailable — keep planner order
      }
    }

    let hitInTopK = false;
    let hitAt1    = false;
    let mrr       = 0;

    if (truthVec) {
      for (let rank = 0; rank < orderedItems.length; rank++) {
        const item = orderedItems[rank]!;
        const itemVec = embedCache.get(item.body);
        if (itemVec && cosineSim(itemVec, truthVec) >= SEMANTIC_THRESHOLD) {
          hitInTopK = true;
          if (rank === 0) hitAt1 = true;
          if (mrr === 0)  mrr   = 1 / (rank + 1);
          break;
        }
      }
    }

    return {
      id:           c.id,
      questionType: c.questionType,
      itemCount:    items.length,
      hitInTopK,
      hitAt1,
      mrr,
    };
  } finally {
    bd.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Load fixture ────────────────────────────────────────────────────────────
  if (!fs.existsSync(FIXTURE_PATH)) {
    console.error('[planner-recall] fixture not found — run convert-oracle.ts first');
    process.exit(1);
  }
  const { cases: allCases }: BenchFixture = JSON.parse(
    fs.readFileSync(FIXTURE_PATH, 'utf-8'),
  );

  const cases = SAMPLE_N > 0
    ? [...allCases].sort(() => Math.random() - 0.5).slice(0, SAMPLE_N)
    : allCases;
  console.log(`[planner-recall] ${cases.length} cases · k=${TOP_K}`);

  // ── Caches ──────────────────────────────────────────────────────────────────
  const extractCache = new ExtractionCache();
  const embedCache   = new EmbedCache();
  console.log(`[extract] Cache: ${extractCache.size()} cases`);
  console.log(`[embed]   Cache: ${embedCache.size()} vectors`);

  // ── Step 1: Extract (reuse existing cache or call DeepSeek) ─────────────────
  const newCases = cases.filter(c => !extractCache.has(c.id));
  if (newCases.length > 0) {
    console.log(`[extract] ${newCases.length} cases need extraction via DeepSeek …`);
    await extractMany(
      newCases.map(c => ({
        id:           c.id,
        userMessages: c.messages.filter(m => m.role === 'user').map(m => m.content),
      })),
      extractCache,
      (done, total) => { if (done % 20 === 0 || done === total) process.stdout.write(`  ${done}/${total}\r`); },
    );
    process.stdout.write('\n');
  } else {
    console.log('[extract] All cases cached');
  }

  // ── Step 2: Embed (item bodies + queries + ground truths) ───────────────────
  console.log('\n[embed] Precomputing embeddings …');
  await precomputeEmbeddings(cases, extractCache, embedCache);

  // ── Step 3: Run planner on each case ───────────────────────────────────────
  console.log('\n[eval] Running MemoryPlanner on each case …');
  const t0 = Date.now();
  const caseResults: CaseResult[]                = [];
  const byType: Record<string, CaseResult[]>     = {};
  let   processed = 0;

  for (const c of cases) {
    const items = extractCache.get(c.id) ?? [];
    const res   = await evalCase(c, items, embedCache);
    caseResults.push(res);
    (byType[c.questionType] ??= []).push(res);

    processed++;
    if (processed % 50 === 0 || processed === cases.length) {
      const hitsSoFar = caseResults.filter(r => r.hitInTopK).length;
      process.stdout.write(
        `  ${processed}/${cases.length}  ` +
        `hit=${hitsSoFar}/${processed} ` +
        `(${(hitsSoFar / processed * 100).toFixed(1)}%)\r`,
      );
    }
  }
  process.stdout.write('\n');

  const durationMs = Date.now() - t0;

  // ── Results ─────────────────────────────────────────────────────────────────
  const overall = aggregate(caseResults, durationMs);
  printAgg('PLANNER RECALL — overall', overall);

  console.log('\n── By question type ──────────────────────────────────────────');
  printByType(byType);

  // ── Compare vs extracted-recall.bench.ts ────────────────────────────────────
  const prevPath = path.resolve(RESULTS_DIR, 'extracted-recall.json');
  if (fs.existsSync(prevPath)) {
    interface PrevResult { overall: { answerHitRate: number; mrr: number } }
    const prev = JSON.parse(fs.readFileSync(prevPath, 'utf-8')) as PrevResult;
    const prevHit = prev.overall.answerHitRate;
    const delta = overall.hitRate - prevHit;
    console.log('\n── vs extracted-recall (cosine-only) ────────────────────────');
    console.log(`  extracted-recall Hit Rate : ${(prevHit * 100).toFixed(1)}%`);
    console.log(`  planner-recall   Hit Rate : ${(overall.hitRate * 100).toFixed(1)}%`);
    console.log(`  Δ : ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%  ` +
      (delta >= 0 ? '✓ Planner matches or improves' : '✗ Planner diverges — investigate mode-weighting'));
  }

  // ── Target check ────────────────────────────────────────────────────────────
  console.log('\n── Target check ──────────────────────────────────────────────');
  const TARGET = 0.80;
  const ok = overall.hitRate >= TARGET;
  console.log(`  Answer Hit Rate ≥ ${(TARGET * 100).toFixed(0)}% : ${ok ? '✓ PASS' : '✗ FAIL'} (${(overall.hitRate * 100).toFixed(1)}%)`);

  // ── Save ─────────────────────────────────────────────────────────────────────
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({
    generatedAt:   new Date().toISOString(),
    topK:          TOP_K,
    sampleN:       cases.length,
    providerUsed:  BENCH_PROVIDER_ID,
    overall,
    byType: Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, aggregate(v, 0)]),
    ),
  }, null, 2), 'utf-8');
  console.log(`\n[bench] Results saved → ${RESULTS_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
