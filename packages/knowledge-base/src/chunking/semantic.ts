import { estimateTextTokens } from '@ema-agent/token';
import type { EbdRouter } from '@ema-agent/ebd-client';
import type { DocumentBlock, DocumentChunk } from '../types.js';
import type { ChunkOptions } from './base.js';
import { chunkId, linkChunks, normalizeChunkSizes } from './base.js';
import { recursiveChunk, RecursiveChunker } from './recursive.js';
import { splitSentences, cosineSimilarity, smoothSimilarities, percentile } from './utils/sentences.js';
import { KbError, classifyKbError } from '../errors.js';

// ── Public option type ────────────────────────────────────────────────────────

export interface SemanticChunkOptions extends ChunkOptions {
  ebdRouter:   EbdRouter;
  providerId:  string;
  model:       string;
  breakThreshold?:     number;   // default 0.5
  breakPercentile?:    number;   // overrides breakThreshold
  smoothWindow?:       number;   // default 3
  bufferSize?:         number;   // default 1
  batchSize?:          number;   // default 32
  /** embed 批次有界并发上限。default 4。大文档上千句时防止一次性打满云 API 限流。 */
  concurrency?:        number;   // default 4
  maxSentencesPerGroup?: number; // default 50
  timeoutMs?:          number;   // default 30_000
  maxRetries?:         number;   // default 2
  signal?:             AbortSignal;
  onBatchFailure?: (failures: Array<{ batchIndex: number; error: string; sentenceCount: number }>) => void;
  onFallback?:     (warn: SemanticFallbackWarning) => void;
}

// ── Error types ───────────────────────────────────────────────────────────────
//
// embed 路径的错误统一走 ../errors.ts 的 KbError(classifyKbError 集中分类 +
// retryable 标记)。这里只保留 SemanticFallbackWarning——它是"降级到递归分块"
// 的观察性警告,不是 embed 调用错误,语义独立。

export class SemanticFallbackWarning extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`SemanticChunker fell back to sentence chunking: ${reason}`);
    this.name = 'SemanticFallbackWarning'; this.reason = reason;
  }
}

// ── SemanticChunker ───────────────────────────────────────────────────────────
// Intentionally does NOT implement Chunker — requires SemanticChunkOptions.

/** embed 批次默认并发上限。与 VisionRouter 全局并发一致(4)。 */
const DEFAULT_EMBED_CONCURRENCY = 4;
// Intentionally does NOT implement Chunker — requires SemanticChunkOptions.

export class SemanticChunker {
  async chunk(blocks: DocumentBlock[], opts: SemanticChunkOptions): Promise<DocumentChunk[]> {
    if (blocks.length === 0) return [];
    const assetId = opts.assetId ?? 'doc';
    const all: DocumentChunk[] = [];
    let   docIdx = 0;

    for (const run of segmentRuns(blocks)) {
      if (run.kind === 'atomic') {
        all.push(makeAtomicChunk(run.blk, chunkId(assetId, docIdx++), assetId));
        continue;
      }
      const sub = await this.chunkTextRun(run.blks, opts, assetId, docIdx);
      docIdx += sub.length;
      all.push(...sub);
    }

    // Shared post-pass: orphan-merge (maxTokens-guarded, atomic-safe). Parent-child
    // (assignParents) is applied later by the ingest pipeline for both chunkers.
    const normalized = normalizeChunkSizes(all, opts, assetId);
    linkChunks(normalized);
    return normalized;
  }

  private async chunkTextRun(blks: DocumentBlock[], opts: SemanticChunkOptions, assetId: string, startIdx: number): Promise<DocumentChunk[]> {
    const batchSize       = opts.batchSize            ?? 32;
    const concurrency     = opts.concurrency          ?? DEFAULT_EMBED_CONCURRENCY;
    const smoothWindow    = opts.smoothWindow         ?? 3;
    const bufferSize      = opts.bufferSize           ?? 1;
    const maxSentGroup    = opts.maxSentencesPerGroup ?? 50;
    const breakThreshold  = opts.breakThreshold       ?? 0.5;
    const timeoutMs       = opts.timeoutMs            ?? 30_000;
    const maxRetries      = opts.maxRetries           ?? 2;

    type SW = { text: string; blk: DocumentBlock };
    const sents: SW[] = [];
    for (const blk of blks) for (const p of splitSentences(blk.text)) if (p.trim()) sents.push({ text: p, blk });

    if (sents.length < 2) return recursiveChunk(blks, opts, assetId);

    const inputs = buildBufferWindow(sents.map(s => s.text), bufferSize);
    const { embeddings, failedBatches } = await embedBatches(inputs, opts.ebdRouter, { providerId: opts.providerId, model: opts.model, batchSize, concurrency, timeoutMs, maxRetries, signal: opts.signal });

    if (failedBatches.length > 0) opts.onBatchFailure?.(failedBatches);
    if (opts.signal?.aborted) return this.fallback(blks, opts, 'aborted');
    if (embeddings.length !== sents.length) return this.fallback(blks, opts, `embed count mismatch: ${embeddings.length}/${sents.length}`);

    const rawSims: number[] = [];
    for (let i = 0; i < embeddings.length - 1; i++) rawSims.push(cosineSimilarity(embeddings[i]!, embeddings[i + 1]!));

    const nanCount = rawSims.filter(s => Number.isNaN(s)).length;
    if (rawSims.length > 0 && nanCount / rawSims.length > 0.5) return this.fallback(blks, opts, `too many NaN similarities: ${nanCount}/${rawSims.length}`);

    const median   = finiteMedian(rawSims);
    const filled   = rawSims.map(s => Number.isNaN(s) ? median : s);
    const smoothed = smoothSimilarities(filled, smoothWindow);
    const threshold = opts.breakPercentile != null ? percentile(smoothed, opts.breakPercentile) : breakThreshold;

    const breaks = new Set<number>();
    for (let i = 0; i < smoothed.length; i++) if (Number.isFinite(smoothed[i]!) && smoothed[i]! < threshold) breaks.add(i);
    for (let i = maxSentGroup - 1; i < sents.length - 1; i += maxSentGroup) breaks.add(i);

    const groups: SW[][] = [];
    let grp: SW[] = [];
    for (let i = 0; i < sents.length; i++) {
      grp.push(sents[i]!);
      if (breaks.has(i)) { groups.push(grp); grp = []; }
    }
    if (grp.length > 0) groups.push(grp);

    const chunks: DocumentChunk[] = [];
    let   idx = startIdx;

    for (const g of groups) {
      const text    = g.map(s => s.text).join(' ').trim();
      const toks    = estimateTextTokens(text);
      const firstBlk = g[0]!.blk;

      if (toks <= opts.maxTokens) {
        // Orphan-merge is handled globally by normalizeChunkSizes() after all runs,
        // which adds a maxTokens guard the old inline merge lacked.
        chunks.push({ id: chunkId(assetId, idx++), assetId, text, blockKinds: ['paragraph'],
          tokenCount: toks, page: firstBlk.page, sectionPath: firstBlk.sectionPath });
      } else {
        const sub = splitByBudget(g, opts, assetId, idx);
        idx += sub.length; chunks.push(...sub);
      }
    }
    return chunks;
  }

  private async fallback(blks: DocumentBlock[], opts: SemanticChunkOptions, reason: string): Promise<DocumentChunk[]> {
    opts.onFallback?.(new SemanticFallbackWarning(reason));
    return new RecursiveChunker().chunk(blks, opts);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type Run = { kind: 'atomic'; blk: DocumentBlock } | { kind: 'text'; blks: DocumentBlock[] };
const ATOMIC: Set<DocumentBlock['kind']> = new Set(['code', 'table', 'image']);

function segmentRuns(blocks: DocumentBlock[]): Run[] {
  const runs: Run[] = [];
  let buf: DocumentBlock[] = [];
  const flush = (): void => { if (buf.length > 0) { runs.push({ kind: 'text', blks: buf }); buf = []; } };
  for (const b of blocks) {
    if (ATOMIC.has(b.kind)) { flush(); runs.push({ kind: 'atomic', blk: b }); }
    else buf.push(b);
  }
  flush();
  return runs;
}

function makeAtomicChunk(blk: DocumentBlock, id: string, assetId: string): DocumentChunk {
  const text = blk.markdown ?? blk.text;
  return { id, assetId, text, ...(blk.markdown ? { markdown: blk.markdown } : {}),
    blockKinds: [blk.kind], tokenCount: estimateTextTokens(text), page: blk.page, sectionPath: blk.sectionPath };
}

function buildBufferWindow(sents: string[], buf: number): string[] {
  if (buf <= 0) return sents;
  return sents.map((_, i) => {
    const lo = Math.max(0, i - buf), hi = Math.min(sents.length - 1, i + buf);
    return sents.slice(lo, hi + 1).join(' ');
  });
}

interface BatchResult { embeddings: number[][]; failedBatches: Array<{ batchIndex: number; error: string; sentenceCount: number }> }

interface EmbedBatchOpts { providerId: string; model: string; batchSize: number; concurrency: number; timeoutMs: number; maxRetries: number; signal?: AbortSignal }

/**
 * 有界并发 embed。N 个 worker 从共享 `next` 索引领 batch,结果按原下标写回 →
 * embeddings 顺序与输入 texts 严格对齐(失败位填 [],与 sents 长度守恒)。
 *
 * 边界:
 * - batches 为空 → 直接返回空,不起 worker。
 * - concurrency clamp 到 [1, batches.length],不起比任务多的 worker。
 * - abort:worker 入口 + 每轮循环检查,已 abort 不领新任务;运行中的 batch 由
 *   embedWithRetry 内部 abort 传播。已完成的向量保留(上层 fallback 自行决定)。
 * - 部分失败:某 batch 失败不杀其他 worker,failedBatches 记录,其余继续。
 */
export async function embedBatches(texts: string[], router: EbdRouter, opts: EmbedBatchOpts): Promise<BatchResult> {
  const batches = chunk(texts, opts.batchSize);
  const failedBatches: BatchResult['failedBatches'] = [];
  if (batches.length === 0) return { embeddings: [], failedBatches };

  const concurrency = Math.max(1, Math.min(opts.concurrency, batches.length));
  const results: Array<{ ok: true; vec: number[][] } | { ok: false; err: KbError; count: number }> = new Array(batches.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (i >= batches.length) return;
      const batch = batches[i]!;
      try {
        const vec = await embedWithRetry(batch, router, { ...opts, batchIndex: i });
        results[i] = { ok: true, vec };
      } catch (err) {
        const kbErr = err instanceof KbError ? err : classifyKbError(err, { providerId: opts.providerId, model: opts.model, batchIndex: i });
        results[i] = { ok: false, err: kbErr, count: batch.length };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const embeddings: number[][] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    // r === undefined:abort 时 worker 未领到该 batch。填 [] 保长度守恒,
    // 不进 failedBatches(上层 `if (aborted) fallback` 自行处理,不算 embed 失败)。
    if (r && r.ok) {
      embeddings.push(...r.vec);
    } else {
      const count = r ? r.count : batches[i]!.length;
      for (let j = 0; j < count; j++) embeddings.push([]);
      if (r) failedBatches.push({ batchIndex: i, error: `${r.err.code}: ${r.err.message}`, sentenceCount: r.count });
    }
  }
  return { embeddings, failedBatches };
}

async function embedWithRetry(texts: string[], router: EbdRouter, opts: EmbedBatchOpts & { batchIndex: number }): Promise<number[][]> {
  const meta = { providerId: opts.providerId, model: opts.model, batchIndex: opts.batchIndex };
  let lastErr: KbError | undefined;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new KbError('kb/embed_aborted', 'Embedding batch aborted before start', { cause: opts.signal.reason, meta: { ...meta, retryable: false } });
    }
    const ctrl = new AbortController();
    let timedOut = false;
    const tid  = setTimeout(() => { timedOut = true; ctrl.abort(new Error('kb/embed_timeout')); }, opts.timeoutMs);
    const onAbort = (): void => ctrl.abort(opts.signal!.reason);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res  = await router.embed({ providerId: opts.providerId, model: opts.model, texts, signal: ctrl.signal });
      clearTimeout(tid); opts.signal?.removeEventListener('abort', onAbort);
      return res.embeddings;
    } catch (err) {
      clearTimeout(tid); opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) {
        throw new KbError('kb/embed_aborted', 'Embedding batch aborted by upstream', { cause: err, meta: { ...meta, retryable: false } });
      }
      const classified = classifyKbError(err, meta, timedOut);
      if (!classified.meta.retryable) throw classified;
      lastErr = classified;
      if (attempt < opts.maxRetries) await sleep(500 * 2 ** attempt, opts.signal);
    }
  }
  throw new KbError('kb/embed_batch_failed', `batch ${opts.batchIndex} failed after ${opts.maxRetries + 1} attempts`, { cause: lastErr, meta: { ...meta, retryable: false } });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) { rej(signal.reason); return; }
    const id = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(id); rej(signal!.reason); }, { once: true });
  });
}

function splitByBudget(sents: { text: string; blk: DocumentBlock }[], opts: ChunkOptions, assetId: string, startIdx: number): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let buf: typeof sents = [], bufToks = 0, idx = startIdx;
  const flush = (): void => {
    if (buf.length === 0) return;
    const text = buf.map(s => s.text).join(' ').trim();
    const b0   = buf[0]!.blk;
    buf = []; bufToks = 0;
    if (text) chunks.push({ id: chunkId(assetId, idx++), assetId, text, blockKinds: ['paragraph'], tokenCount: estimateTextTokens(text), page: b0.page, sectionPath: b0.sectionPath });
  };
  for (const s of sents) {
    const t = estimateTextTokens(s.text);
    if (t > opts.maxTokens) { flush(); chunks.push({ id: chunkId(assetId, idx++), assetId, text: s.text, blockKinds: ['paragraph'], tokenCount: t, page: s.blk.page, sectionPath: s.blk.sectionPath }); continue; }
    if (bufToks + t > opts.maxTokens) flush();
    buf.push(s); bufToks += t;
  }
  flush();
  return chunks;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function finiteMedian(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length === 0 ? 0.5 : sorted[Math.floor(sorted.length / 2)]!;
}
