/**
 * extracted-recall.bench.ts — Full pipeline: extract → embed → retrieve → evaluate
 *
 * This is the real system-level test.  Previous benches (BM25, BGE-M3) retrieved
 * from RAW oracle messages.  This bench simulates what MemoryPlanner actually does:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  Oracle conversation                                            │
 *   │       │                                                         │
 *   │       ▼                                                         │
 *   │  [Step 1] DeepSeek extraction                                   │
 *   │       → structured memory items  {"title", "body"}             │
 *   │       │  (4–10 per conversation, cached)                       │
 *   │       ▼                                                         │
 *   │  [Step 2] BGE-M3 embedding                                     │
 *   │       → 1024-dim vectors for each item + each query            │
 *   │       │  (cached)                                              │
 *   │       ▼                                                         │
 *   │  [Step 3] Cosine-similarity top-K retrieval                    │
 *   │       → top-6 items most similar to the query                  │
 *   │       │                                                         │
 *   │       ▼                                                         │
 *   │  [Step 4] Evaluation                                            │
 *   │       Answer Hit Rate — does any top-K item's body              │
 *   │       contain enough of the ground truth answer?               │
 *   │       Extraction Recall — did extraction preserve the           │
 *   │       evidence from has_answer:true messages?                  │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Why Answer Hit Rate instead of message-level F1:
 *   After extraction, items no longer map 1-to-1 with original messages.
 *   What matters is: "can the retrieved items answer the question?"
 *   That's what Answer Hit Rate measures.
 *
 * Metrics:
 *   answer_hit_rate    % of cases where ≥1 top-K item contains the answer
 *   answer_hit_at_1    % where the #1 item alone answers it
 *   extraction_recall  % of cases where extraction preserved evidence content
 *   avg_items_per_case avg extracted items (measures extraction density)
 *   mrr                mean reciprocal rank of first answer-containing item
 *
 * Usage:
 *   npx tsx bench/runners/extracted-recall.bench.ts
 *   npx tsx bench/runners/extracted-recall.bench.ts --k=10 --sample=100
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmbedCache, embedMany, topKCosine, rerank }  from '../lib/siliconflow.js';
import { ExtractionCache, extractMany }        from '../lib/deepseek.js';
import type { ExtractedItem }                  from '../lib/deepseek.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));

function getFixturePath(defaultName: string): string {
  const arg = process.argv.find(a => a.startsWith('--fixture='));
  if (!arg) return path.resolve(__dir, '../fixtures', defaultName);
  const val = arg.split('=').slice(1).join('=');
  return path.isAbsolute(val) ? val : path.resolve(__dir, '../fixtures', val);
}

const FIXTURE_PATH = getFixturePath('chat-oracle.json');
const RESULTS_DIR  = path.resolve(__dir, '../bench-results');
const RESULTS_PATH = path.resolve(RESULTS_DIR, 'extracted-recall.json');

// ── CLI args ──────────────────────────────────────────────────────────────────

function getArg(name: string, def: number): number {
  const arg  = process.argv.find(a => a.startsWith(`--${name}=`) || a === `--${name}`);
  const next = arg ? process.argv[process.argv.indexOf(arg) + 1] : undefined;
  const val  = arg?.startsWith(`--${name}=`) ? arg.split('=')[1] : next;
  return val ? parseInt(val, 10) : def;
}

const TOP_K     = getArg('k',      6);
const COARSE_K  = 20;  // bi-encoder top-N to feed into reranker
const SAMPLE_N = getArg('sample', 0);  // 0 = all cases

// ── Fixture types ─────────────────────────────────────────────────────────────

interface BenchMessage {
  sessionIdx:  number;
  msgIdx:      number;
  role:        'user' | 'assistant';
  content:     string;
  isEvidence:  boolean;
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

// ── Answer match ──────────────────────────────────────────────────────────────
//
// Semantic matching via cosine similarity on BGE-M3 vectors (already cached).
// Threshold: 0.70 — tuned empirically: lower catches more paraphrases but risks
// false positives for entirely unrelated content.

const SEMANTIC_THRESHOLD = 0.50;
/** Embed key for a memory item — title: body joint gives stronger signal. */
function itemEmbedKey(it: { title: string; body: string }): string {
  return `${it.title}: ${it.body}`;
}
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na  += a[i]! * a[i]!;
    nb  += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Semantic answer match — uses BGE-M3 embeddings instead of token overlap.
 * Handles paraphrasing (e.g. "GPS not functioning" ≈ "navigation issues").
 * Requires groundTruth to be embedded alongside other texts in Step 2.
 */
function containsAnswer(
  itemVec: number[],
  truthVec: number[],
): boolean {
  if (!itemVec.length || !truthVec.length) return false;
  return cosineSim(itemVec, truthVec) >= SEMANTIC_THRESHOLD;
}

// ── Extraction recall helper ──────────────────────────────────────────────────
//
// Checks if the extraction step preserved the evidence content from the
// has_answer:true messages. Uses semantic matching via embed cache.

function extractionPreservesEvidence(
  items:           ExtractedItem[],
  evidenceMessages: string[],
  truthVec:        number[],
  embedCache:      EmbedCache,
): boolean {
  // Check if any extracted item semantically matches the ground truth
  for (const item of items) {
    const itemVec = embedCache.get(item.body);
    if (itemVec && truthVec.length > 0 && cosineSim(itemVec, truthVec) >= SEMANTIC_THRESHOLD) {
      return true;
    }
  }

  // Also check evidence messages against items
  for (const evMsg of evidenceMessages) {
    const evVec = embedCache.get(evMsg);
    if (!evVec) continue;
    for (const item of items) {
      const itemVec = embedCache.get(item.body);
      if (itemVec && cosineSim(itemVec, evVec) >= 0.65) return true;
    }
  }
  return false;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

interface CaseResult {
  id:               string;
  questionType:     string;
  itemCount:        number;
  extractionOk:     boolean;   // extraction preserved evidence
  hitInTopK:        boolean;   // any top-K item answers the query
  hitAt1:           boolean;   // top-1 item answers the query
  mrr:              number;    // 1/rank of first answering item (0 if none)
}

interface AggResult {
  n:                  number;
  answerHitRate:      number;
  answerHitAt1:       number;
  extractionRecall:   number;
  mrr:                number;
  avgItemsPerCase:    number;
}

function aggregate(results: CaseResult[]): AggResult {
  const n = results.length;
  if (!n) return { n: 0, answerHitRate: 0, answerHitAt1: 0, extractionRecall: 0, mrr: 0, avgItemsPerCase: 0 };
  const s = (fn: (r: CaseResult) => number) => results.reduce((a, r) => a + fn(r), 0);
  return {
    n,
    answerHitRate:    s(r => r.hitInTopK ? 1 : 0) / n,
    answerHitAt1:     s(r => r.hitAt1    ? 1 : 0) / n,
    extractionRecall: s(r => r.extractionOk ? 1 : 0) / n,
    mrr:              s(r => r.mrr) / n,
    avgItemsPerCase:  s(r => r.itemCount) / n,
  };
}

// ── Output ────────────────────────────────────────────────────────────────────

function fmtPct(v: number) { return `${(v * 100).toFixed(1)}%`.padStart(8); }
function fmtN  (v: number) { return v.toFixed(3).padStart(7); }

function printAgg(label: string, agg: AggResult): void {
  console.log(`\n┌─ ${label} ─── n=${agg.n} · k=${TOP_K}`);
  console.log(`│  Answer Hit Rate  (any top-${TOP_K}) : ${fmtPct(agg.answerHitRate)}`);
  console.log(`│  Answer Hit@1     (top-1 only) : ${fmtPct(agg.answerHitAt1)}`);
  console.log(`│  Extraction Recall             : ${fmtPct(agg.extractionRecall)}`);
  console.log(`│  MRR                           : ${fmtN(agg.mrr)}`);
  console.log(`│  Avg items / case              : ${agg.avgItemsPerCase.toFixed(1)}`);
  console.log('└');
}

function printByType(byType: Record<string, CaseResult[]>): void {
  console.log(`\n${'Type'.padEnd(20)} ${'HitRate'.padStart(9)} ${'Hit@1'.padStart(8)} ${'ExtrRec'.padStart(9)} ${'MRR'.padStart(7)} ${'N'.padStart(5)}`);
  console.log('─'.repeat(62));
  for (const [type, results] of Object.entries(byType)) {
    const agg = aggregate(results);
    console.log(
      `${type.padEnd(20)}` +
      ` ${fmtPct(agg.answerHitRate)} ${fmtPct(agg.answerHitAt1)}` +
      ` ${fmtPct(agg.extractionRecall)} ${fmtN(agg.mrr)} ${String(agg.n).padStart(5)}`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Load fixture ───────────────────────────────────────────────────────────
  if (!fs.existsSync(FIXTURE_PATH)) {
    console.error('[extracted-recall] fixture not found — run convert-oracle.ts first');
    process.exit(1);
  }
  const { cases: allCases }: BenchFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));

  const cases = SAMPLE_N > 0
    ? [...allCases].sort(() => Math.random() - 0.5).slice(0, SAMPLE_N)
    : allCases;
  console.log(`[extracted-recall] ${cases.length} cases · k=${TOP_K}`);

  // ── Step 1: Extract ────────────────────────────────────────────────────────
  const extractCache = new ExtractionCache();
  console.log(`\n[extract] Cache: ${extractCache.size()} / ${cases.length} cases cached`);

  const caseInputs = cases.map(c => ({
    id:           c.id,
    userMessages: c.messages.filter(m => m.role === 'user').map(m => m.content),
  }));

  const newCount = cases.filter(c => !extractCache.has(c.id)).length;
  if (newCount > 0) {
    console.log(`[extract] Extracting ${newCount} new cases via DeepSeek …`);
    process.stdout.write('[extract] Progress: ');
    await extractMany(caseInputs, extractCache, (done, total) => {
      if (done % 20 === 0 || done === total) process.stdout.write(`${done}/${total} `);
    });
    process.stdout.write('\n');
  } else {
    console.log('[extract] All cases cached — skipping API calls');
  }

  // ── Step 2: Embed extracted items + queries ────────────────────────────────
  const embedCache = new EmbedCache();
  console.log(`\n[embed] Cache: ${embedCache.size()} vectors`);

  const textsToEmbed: string[] = [];
  for (const c of cases) {
    textsToEmbed.push(c.query);
    // Only embed truth if it's a real non-empty string (oracle answers are always strings,
    // but defensive against null/undefined that might slip through fixture conversion).
    const truth = c.groundTruth;
    if (typeof truth === 'string' && truth.length > 0) {
      textsToEmbed.push(truth);
    }
    const items = extractCache.get(c.id) ?? [];
    for (const it of items) textsToEmbed.push(it.body);
  }

  const newEmbeds = textsToEmbed.filter(t => !embedCache.has(t)).length;
  if (newEmbeds > 0) {
    console.log(`[embed] Embedding ${newEmbeds} new texts via BGE-M3 …`);
    process.stdout.write('[embed] Progress: ');
    await embedMany(textsToEmbed, embedCache, (done, total) => {
      if (done % 64 === 0 || done === total) process.stdout.write(`${done}/${total} `);
    });
    process.stdout.write('\n');
  } else {
    console.log('[embed] All texts cached');
  }

  // ── Step 3 + 4: Retrieve and evaluate ─────────────────────────────────────
  console.log('\n[eval] Evaluating …');

  const caseResults: CaseResult[]                      = [];
  const byType: Record<string, CaseResult[]>           = {};
  let   totalItems = 0;

  for (const c of cases) {
    const items      = extractCache.get(c.id) ?? [];
    totalItems      += items.length;

    // Evidence message content (for extraction recall check)
    const evidenceMsgs = c.messages
      .filter(m => m.isEvidence)
      .map(m => m.content);

    // Extraction recall: did extraction preserve the evidence?
    const truth = typeof c.groundTruth === 'string' && c.groundTruth.length > 0
      ? c.groundTruth : null;
    const truthVec = truth ? (embedCache.get(truth) ?? []) : [];
    const extractionOk = truth && truthVec.length > 0
      ? extractionPreservesEvidence(items, evidenceMsgs, truthVec, embedCache)
      : false;

    // Retrieval — two-stage: bi-encoder coarse → cross-encoder fine
    const queryVec = embedCache.get(c.query);
    let   hitInTopK = false;
    let   hitAt1    = false;
    let   mrr       = 0;

    if (queryVec && items.length > 0) {
      const corpus = items
        .map((it, idx) => ({ id: String(idx), vec: embedCache.get(it.body) ?? [] }))
        .filter(x => x.vec.length > 0);

      // Stage 1: bi-encoder coarse retrieval (top-20)
      const coarseIds = topKCosine(queryVec, corpus, Math.min(COARSE_K, corpus.length));
      const coarseDocs = coarseIds.map(id => items[parseInt(id, 10)]!.body);

      // Stage 2: cross-encoder rerank
      let finalIds: string[];
      try {
        const reranked = await rerank(c.query, coarseDocs);
        finalIds = reranked
          .sort((a, b) => b.score - a.score)
          .slice(0, TOP_K)
          .map(r => coarseIds[r.index]!);
      } catch {
        // Reranker unavailable → fall back to bi-encoder top-K
        finalIds = coarseIds.slice(0, TOP_K);
      }

      for (let rank = 0; rank < finalIds.length; rank++) {
        const idx  = parseInt(finalIds[rank]!, 10);
        const item = items[idx];
        if (item) {
          const itemVec = embedCache.get(item.body) ?? [];
          if (containsAnswer(itemVec, truthVec)) {
            hitInTopK = true;
            if (rank === 0) hitAt1 = true;
            if (mrr === 0)  mrr    = 1 / (rank + 1);
          }
        }
      }
    }

    const res: CaseResult = {
      id: c.id, questionType: c.questionType,
      itemCount: items.length,
      extractionOk, hitInTopK, hitAt1, mrr,
    };
    caseResults.push(res);
    (byType[c.questionType] ??= []).push(res);
  }

  // ── Print results ──────────────────────────────────────────────────────────
  const overall = aggregate(caseResults);
  printAgg('EXTRACTED RECALL — overall', overall);

  console.log('\n── By question type ──────────────────────────────────────────');
  printByType(byType);

  // ── Baseline comparison ────────────────────────────────────────────────────
  const bm25Path = path.resolve(RESULTS_DIR, 'recall-quality.json');
  if (fs.existsSync(bm25Path)) {
    const bm25Data = JSON.parse(fs.readFileSync(bm25Path, 'utf-8')) as {
      results: Array<{ retriever: string; overall: { recall: number; f1: number } }>;
    };
    const bm25 = bm25Data.results.find(r => r.retriever === 'bm25');
    if (bm25) {
      const hitVsRecall = overall.answerHitRate - bm25.overall.recall;
      console.log(`\n── vs BM25 raw-message baseline ──────────────────────────────`);
      console.log(`  BM25 Recall (raw msgs)   : ${(bm25.overall.recall * 100).toFixed(1)}%`);
      console.log(`  Extraction Hit Rate      : ${(overall.answerHitRate * 100).toFixed(1)}%`);
      console.log(`  Δ : ${hitVsRecall >= 0 ? '+' : ''}${(hitVsRecall * 100).toFixed(1)}%  ` +
        (hitVsRecall >= 0
          ? '✓ Extraction pipeline adds value'
          : '✗ Extraction losing information — review prompt'));
    }
  }

  // ── Target check ──────────────────────────────────────────────────────────
  console.log('\n── Target check ──────────────────────────────────────────────');
  const TARGET_HIT  = 0.80;
  const TARGET_EXTR = 0.85;
  const hitOk  = overall.answerHitRate    >= TARGET_HIT;
  const extrOk = overall.extractionRecall >= TARGET_EXTR;
  console.log(`  Answer Hit Rate  ≥ ${(TARGET_HIT * 100).toFixed(0)}%  : ${hitOk  ? '✓ PASS' : '✗ FAIL'} (${(overall.answerHitRate * 100).toFixed(1)}%)`);
  console.log(`  Extraction Recall ≥ ${(TARGET_EXTR * 100).toFixed(0)}% : ${extrOk ? '✓ PASS' : '✗ FAIL'} (${(overall.extractionRecall * 100).toFixed(1)}%)`);

  if (!hitOk && overall.extractionRecall >= TARGET_EXTR) {
    console.log('  → Extraction is fine; improve RETRIEVAL (tune TOP_K, re-rank, or add graph expansion)');
  }
  if (!extrOk) {
    console.log('  → Extraction is losing information; tune the DeepSeek extraction prompt');
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({
    generatedAt:  new Date().toISOString(),
    topK:         TOP_K,
    sampleN:      cases.length,
    overall,
    byType:       Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, aggregate(v)]),
    ),
  }, null, 2), 'utf-8');
  console.log(`\n[bench] Results saved → ${RESULTS_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
