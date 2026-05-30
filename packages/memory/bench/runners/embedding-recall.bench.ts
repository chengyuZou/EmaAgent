/**
 * embedding-recall.bench.ts — BGE-M3 semantic retrieval vs BM25 baseline.
 *
 * What this answers:
 *   "Does semantic embedding (BGE-M3) find the evidence messages better
 *    than keyword search (BM25)?"
 *
 *   If embedding F1 ≤ BM25 F1, the vector index adds noise — fix the
 *   extraction pipeline or try a different embedding model first.
 *
 * What is being retrieved:
 *   USER messages from oracle haystack_sessions, indexed by their content.
 *   Ground truth = messages marked has_answer:true (same as recall-quality.bench.ts).
 *
 *   This is NOT the full MemoryPlanner flow (which uses extracted memory_nodes
 *   + memory_items).  It's a direct comparison: keyword vs semantic retrieval
 *   on the same raw corpus.
 *
 * First run:  embeds ~5 600 texts via SiliconFlow API → saves cache (~30 MB)
 * Later runs: loads cache, zero API calls.
 *
 * Usage:
 *   npx tsx bench/runners/embedding-recall.bench.ts
 *   npx tsx bench/runners/embedding-recall.bench.ts --k=10
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmbedCache, embedMany, topKCosine } from '../lib/siliconflow.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));

function getFixturePath(defaultName: string): string {
  const arg = process.argv.find(a => a.startsWith('--fixture='));
  if (!arg) return path.resolve(__dir, '../fixtures', defaultName);
  const val = arg.split('=').slice(1).join('=');
  return path.isAbsolute(val) ? val : path.resolve(__dir, '../fixtures', val);
}

const FIXTURE_PATH = getFixturePath('chat-oracle.json');
const RESULTS_DIR  = path.resolve(__dir, '../bench-results');
const RESULTS_PATH = path.resolve(RESULTS_DIR, 'embedding-recall.json');

const TOP_K = (() => {
  const arg  = process.argv.find(a => a.startsWith('--k=') || a === '--k');
  const next = arg ? process.argv[process.argv.indexOf(arg) + 1] : undefined;
  const val  = arg?.startsWith('--k=') ? arg.split('=')[1] : next;
  return val ? parseInt(val, 10) : 6;
})();

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
  totalMessages:      number;
}

interface BenchFixture {
  meta:  { totalCases: number };
  cases: BenchCase[];
}

// ── Metric helpers ────────────────────────────────────────────────────────────

interface QMetrics { precision: number; recall: number; f1: number; mrr: number; hitAt1: number }

function computeMetrics(relevant: Set<string>, retrieved: string[]): QMetrics {
  let tp = 0, firstRank = -1;
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i]!)) { tp++; if (firstRank < 0) firstRank = i + 1; }
  }
  const k  = retrieved.length;
  const p  = k > 0             ? tp / k              : 0;
  const r  = relevant.size > 0 ? tp / relevant.size  : 0;
  const f1 = p + r > 0         ? 2 * p * r / (p + r) : 0;
  return { precision: p, recall: r, f1, mrr: firstRank > 0 ? 1 / firstRank : 0, hitAt1: k > 0 && relevant.has(retrieved[0]!) ? 1 : 0 };
}

function avgMetrics(ms: QMetrics[]): QMetrics {
  const n = ms.length;
  if (!n) return { precision: 0, recall: 0, f1: 0, mrr: 0, hitAt1: 0 };
  const s = (k: keyof QMetrics) => ms.reduce((a, m) => a + m[k], 0);
  return { precision: s('precision')/n, recall: s('recall')/n, f1: s('f1')/n, mrr: s('mrr')/n, hitAt1: s('hitAt1')/n };
}

// ── BM25 (reproduced for local comparison) ────────────────────────────────────

class BM25Lite {
  private idf = new Map<string, number>();
  private docs: Array<{ id: string; tokens: string[]; len: number }> = [];
  private avgdl = 0;

  private static tok(t: string) { return t.toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length >= 2); }

  fit(docs: Array<{ id: string; text: string }>): void {
    const df = new Map<string, number>();
    this.docs = docs.map(d => {
      const tokens = BM25Lite.tok(d.text);
      for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
      return { id: d.id, tokens, len: tokens.length };
    });
    this.avgdl = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
    this.idf.clear();
    for (const [t, n] of df) this.idf.set(t, Math.log((docs.length - n + 0.5) / (n + 0.5) + 1));
  }

  query(text: string, k: number): string[] {
    const qTokens = BM25Lite.tok(text);
    const scores  = new Map<string, number>();
    for (const doc of this.docs) {
      let s = 0;
      const tf = new Map<string, number>();
      for (const t of doc.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of qTokens) {
        const idf = this.idf.get(t); if (!idf) continue;
        const f   = tf.get(t) ?? 0;
        s += idf * (f * 2.5) / (f + 1.5 * (1 - 0.75 + 0.75 * doc.len / this.avgdl));
      }
      if (s > 0) scores.set(doc.id, s);
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
  }
}

// ── Pre-compute: embed all corpus texts ───────────────────────────────────────

async function precomputeEmbeddings(
  cases:  BenchCase[],
  cache:  EmbedCache,
): Promise<void> {
  // Collect all unique user-message texts + query texts
  const allTexts = new Set<string>();
  for (const c of cases) {
    allTexts.add(c.query);
    for (const m of c.messages) {
      if (m.role === 'user') allTexts.add(m.content);
    }
  }

  const total   = allTexts.size;
  const already = [...allTexts].filter(t => cache.has(t)).length;
  const newCount = total - already;

  console.log(`[embed] Corpus: ${total} unique texts  (${already} cached, ${newCount} new)`);

  if (newCount === 0) { console.log('[embed] All cached — no API calls needed'); return; }

  process.stdout.write('[embed] Embedding');
  await embedMany([...allTexts], cache, (done, total_) => {
    if (done % 64 === 0 || done === total_) process.stdout.write(` ${done}/${total_}`);
  });
  process.stdout.write('\n');
  console.log('[embed] Done');
}

// ── Retrieval functions ───────────────────────────────────────────────────────

function bm25Retrieve(c: BenchCase, k: number): string[] {
  const bm25 = new BM25Lite();
  const docs  = c.messages.filter(m => m.role === 'user').map(m => ({ id: `${m.sessionIdx}_${m.msgIdx}`, text: m.content }));
  bm25.fit(docs);
  return bm25.query(c.query, k);
}

function embeddingRetrieve(c: BenchCase, k: number, cache: EmbedCache): string[] {
  const queryVec = cache.get(c.query);
  if (!queryVec) return [];   // shouldn't happen after precompute

  const corpus = c.messages
    .filter(m => m.role === 'user')
    .map(m => ({ id: `${m.sessionIdx}_${m.msgIdx}`, vec: cache.get(m.content) ?? [] }))
    .filter(item => item.vec.length > 0);

  return topKCosine(queryVec, corpus, k);
}

// ── Aggregation + printing ────────────────────────────────────────────────────

const SEP = '─'.repeat(58);

function fmtN(v: number, w = 7) { return v.toFixed(3).padStart(w); }

function printResult(
  name:    string,
  overall: QMetrics,
  byType:  Record<string, QMetrics>,
  n:       number,
  ms:      number,
): void {
  console.log(`\n┌─ ${name.toUpperCase()} ─── n=${n} · k=${TOP_K} · ${ms}ms`);
  console.log(`│ ${'Type'.padEnd(20)} ${'F1'.padStart(7)} ${'Recall'.padStart(8)} ${'Prec'.padStart(7)} ${'MRR'.padStart(7)} ${'Hit@1'.padStart(7)}`);
  console.log(`│ ${SEP}`);
  const row = (l: string, m: QMetrics) =>
    console.log(`│ ${l.padEnd(20)} ${fmtN(m.f1)} ${fmtN(m.recall, 8)} ${fmtN(m.precision)} ${fmtN(m.mrr)} ${fmtN(m.hitAt1)}`);
  row('OVERALL', overall);
  console.log(`│ ${SEP}`);
  for (const [type, m] of Object.entries(byType)) row(type, m);
  console.log('└');
}

function runRetriever(
  name:     string,
  cases:    BenchCase[],
  retrieve: (c: BenchCase) => string[],
): { overall: QMetrics; byType: Record<string, QMetrics>; durationMs: number } {
  const t0   = Date.now();
  const all: QMetrics[] = [];
  const byType: Record<string, QMetrics[]> = {};
  for (const c of cases) {
    const m = computeMetrics(new Set(c.relevantMessageIds), retrieve(c));
    all.push(m);
    (byType[c.questionType] ??= []).push(m);
  }
  const durationMs = Date.now() - t0;
  const overall    = avgMetrics(all);
  const byTypeAvg  = Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, avgMetrics(v)]));
  printResult(name, overall, byTypeAvg, cases.length, durationMs);
  return { overall, byType: byTypeAvg, durationMs };
}

// ── Delta helper ──────────────────────────────────────────────────────────────

function delta(label: string, base: QMetrics, target: QMetrics): void {
  const fmt = (a: number, b: number) => {
    const d = ((b - a) / Math.max(a, 1e-9)) * 100;
    return (d >= 0 ? '▲+' : '▼') + d.toFixed(1) + '%';
  };
  console.log(
    `  Δ vs ${label}: ` +
    `F1 ${fmt(base.f1, target.f1)}  ` +
    `Recall ${fmt(base.recall, target.recall)}  ` +
    `MRR ${fmt(base.mrr, target.mrr)}  ` +
    `Hit@1 ${fmt(base.hitAt1, target.hitAt1)}`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[embedding-recall] Loading fixture …');
  if (!fs.existsSync(FIXTURE_PATH)) {
    console.error('[embedding-recall] fixture not found — run convert-oracle.ts first');
    process.exit(1);
  }

  const { cases }: BenchFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  console.log(`[embedding-recall] ${cases.length} cases · k=${TOP_K}`);

  // Load (or create) embedding cache
  const cache = new EmbedCache();
  console.log(`[embed] Cache loaded: ${cache.size()} vectors`);

  // Embed everything — skips already-cached texts
  await precomputeEmbeddings(cases, cache);

  // ── Run retrievers ────────────────────────────────────────────────────────

  console.log('\n[embedding-recall] Running BM25 …');
  const bm25Res = runRetriever('bm25', cases, c => bm25Retrieve(c, TOP_K));

  console.log('\n[embedding-recall] Running BGE-M3 (embedding) …');
  const embedRes = runRetriever('bge-m3', cases, c => embeddingRetrieve(c, TOP_K, cache));
  delta('bm25', bm25Res.overall, embedRes.overall);

  // ── Summary table ─────────────────────────────────────────────────────────
  console.log('\n═══ SUMMARY ═══════════════════════════════════════════════════════');
  console.log(`${'Retriever'.padEnd(16)} ${'F1'.padStart(7)} ${'Recall'.padStart(8)} ${'Prec'.padStart(7)} ${'MRR'.padStart(7)} ${'Hit@1'.padStart(7)}`);
  console.log('─'.repeat(58));
  const row = (name: string, m: QMetrics) =>
    console.log(`${name.padEnd(16)} ${fmtN(m.f1)} ${fmtN(m.recall, 8)} ${fmtN(m.precision)} ${fmtN(m.mrr)} ${fmtN(m.hitAt1)}`);
  row('bm25',    bm25Res.overall);
  row('bge-m3',  embedRes.overall);
  console.log(`\nTarget (MemoryPlanner): F1 ≥ 0.750 · Recall ≥ 0.800`);

  if (embedRes.overall.f1 > bm25Res.overall.f1) {
    console.log('✓ BGE-M3 > BM25 — semantic embedding adds value on this corpus');
  } else {
    console.log('✗ BGE-M3 ≤ BM25 — investigate embedding quality or corpus representation');
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    topK:        TOP_K,
    results: [
      { retriever: 'bm25',   ...bm25Res },
      { retriever: 'bge-m3', ...embedRes },
    ],
  }, null, 2), 'utf-8');
  console.log(`\n[bench] Results saved → ${RESULTS_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
