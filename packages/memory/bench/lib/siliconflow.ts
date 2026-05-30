/**
 * siliconflow.ts — SiliconFlow BGE-M3 embedding client with disk cache.
 *
 * Cache strategy:
 *   Key  = sha256(text).slice(0,24)   (collision probability negligible)
 *   File = bench/cache/bge-m3.json    (gitignored)
 *
 * On the first run all unique texts are embedded via the API.
 * Subsequent runs load from cache — zero API calls unless new texts arrive.
 *
 * Configuration (env vars take precedence over hard-coded defaults):
 *   SILICONFLOW_API_KEY   SiliconFlow secret key
 *   SILICONFLOW_BASE_URL  defaults to https://api.siliconflow.cn/v1
 *   EMBED_MODEL           defaults to Pro/BAAI/bge-m3
 */

import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL   = process.env['SILICONFLOW_BASE_URL'] ?? 'https://api.siliconflow.cn/v1';
const API_KEY    = process.env['SILICONFLOW_API_KEY']  ?? '';
const MODEL      = process.env['EMBED_MODEL']          ?? 'Pro/BAAI/bge-m3';
export const EMBED_DIM   = 1024;
const BATCH_SIZE = 32;   // SiliconFlow supports up to 64; 32 is safe
const DELAY_MS   = 120;  // polite delay between batches (avoids 429)

const CACHE_PATH = path.resolve(__dir, '../cache/bge-m3.json');

// ── Cache ─────────────────────────────────────────────────────────────────────

type VecCache = Record<string, number[]>;

function hash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 24);
}

export class EmbedCache {
  private store: VecCache = {};
  private dirty = false;

  constructor(private readonly filePath = CACHE_PATH) {
    if (fs.existsSync(filePath)) {
      try {
        this.store = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as VecCache;
      } catch {
        this.store = {};
      }
    }
  }

  size(): number { return Object.keys(this.store).length; }

  has(text: string): boolean { return hash(text) in this.store; }

  get(text: string): number[] | undefined { return this.store[hash(text)]; }

  set(text: string, vec: number[]): void {
    this.store[hash(text)] = vec;
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.store), 'utf-8');
    this.dirty = false;
  }
}

// ── API call ──────────────────────────────────────────────────────────────────

async function callEmbedAPI(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`${BASE_URL}/embeddings`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:           MODEL,
      input:           texts,
      encoding_format: 'float',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`SiliconFlow ${resp.status}: ${body.slice(0, 200)}`);
  }

  const json = await resp.json() as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  const out: number[][] = new Array(texts.length);
  for (const item of json.data) out[item.index] = item.embedding;
  return out;
}

// ── Public: embed many texts with caching ────────────────────────────────────

export async function embedMany(
  texts:       string[],
  cache:       EmbedCache,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const uncached = [...new Set(texts)].filter(t => !cache.has(t));
  if (uncached.length === 0) return;

  let done = 0;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    const vecs  = await callEmbedAPI(batch);
    for (let j = 0; j < batch.length; j++) cache.set(batch[j]!, vecs[j]!);
    done += batch.length;
    onProgress?.(done, uncached.length);
    if (i + BATCH_SIZE < uncached.length) {
      await new Promise<void>(r => setTimeout(r, DELAY_MS));
    }
  }

  cache.save();
}

// ── Cosine similarity + top-K ─────────────────────────────────────────────────

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na  += a[i]! * a[i]!;
    nb  += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na * nb);
  return denom > 0 ? dot / denom : 0;
}

export function topKCosine(
  query:  number[],
  corpus: Array<{ id: string; vec: number[] }>,
  k:      number,
): string[] {
  return corpus
    .map(item => ({ id: item.id, score: cosine(query, item.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(item => item.id);
}

// ── Reranker (cross-encoder) ─────────────────────────────────────────────────
//
// BGE-M3 bi-encoder does coarse retrieval (fast, one vec per doc).
// Cross-encoder sees query+doc as a pair through full transformer attention,
// producing much higher quality relevance scores. 10-50x slower but only
// on top-K candidates, so total pipeline latency stays under ~200ms.
//
// API: SiliconFlow /v1/rerank (Jina/Cohere compatible)
// Model: BAAI/bge-reranker-v2-m3 (same embedding family as BGE-M3)

const RERANK_MODEL = 'BAAI/bge-reranker-v2-m3';

export async function rerank(
  query:     string,
  documents: string[],
): Promise<Array<{ index: number; score: number }>> {
  if (documents.length === 0) return [];

  const resp = await fetch(`${BASE_URL}/rerank`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:     RERANK_MODEL,
      query,
      documents,
      top_n:     documents.length,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Rerank ${resp.status}: ${body.slice(0, 200)}`);
  }

  const json = await resp.json() as {
    results: Array<{ index: number; relevance_score: number }>;
  };

  return json.results.map(r => ({
    index: r.index,
    score: r.relevance_score,
  }));
}
