// 语义 chunker：按相邻句嵌入的相似度断点切分文本；原子块（code/table/image）不参与，
// 嵌入失败或结果不可信时整体降级到递归分块。
import { estimateTextTokens } from '@ema-agent/token';
import type { CallEmbed, DocumentBlock, DocumentChunk } from '../types.js';
import { SemanticFallbackWarning, KnowledgeEmbedAbortedError, KnowledgeEmbedBatchError } from '../errors.js';
import type { ChunkOptions } from './base.js';
import { chunkId, normalizeChunkSizes } from './base.js';
import { recursiveChunk, RecursiveChunker } from './recursive.js';
import { splitSentences, cosineSimilarity, smoothSimilarities, percentile } from './utils/sentences.js';

// ── Public option type ────────────────────────────────────────────────────────

export interface SemanticChunkOptions extends ChunkOptions {
  /** 操作开始时已冻结的单次 embed 调用（模型身份在装配层冻结）。 */
  embed:       CallEmbed;
  /** 相邻句余弦相似度低于该值即断点。default 0.5。 */
  breakThreshold?:     number;
  /** 按相似度分布的分位数取断点阈值（0-100），覆盖 breakThreshold；自适应长短文档。 */
  breakPercentile?:    number;
  /** 相似度平滑的尾随窗口大小，抑制单点抖动造成的误断点。default 3。 */
  smoothWindow?:       number;
  /** embed 输入的上下文窗口：每句前后各带几句一起嵌入。default 1。 */
  bufferSize?:         number;
  /** 单次 embed 请求的句数。default 32。 */
  batchSize?:          number;
  /** embed 批次有界并发上限。default 4。大文档上千句时防止一次性打满云 API 限流。 */
  concurrency?:        number;
  /** 单组句数硬上限，相似度失真时也能强制断开。default 50。 */
  maxSentencesPerGroup?: number;
  /** 单次 embed 尝试的超时（每次重试独立计时）。default 30_000。 */
  timeoutMs?:          number;
  /** 每批失败后的重试次数，指数退避。default 2。 */
  maxRetries?:         number;
  signal?:             AbortSignal;
  onBatchFailure?: (failures: Array<{ batchIndex: number; error: string; sentenceCount: number }>) => void;
  onFallback?:     (warn: SemanticFallbackWarning) => void;
}

/** Embed 批次默认并发上限；数值暂与 Vision 全局默认并发一致，但两者独立控制。 */
const DEFAULT_EMBED_CONCURRENCY = 4;

export class SemanticChunker {
  async chunk(blocks: DocumentBlock[], opts: SemanticChunkOptions): Promise<DocumentChunk[]> {
    if (blocks.length === 0) return [];
    const assetId = opts.assetId ?? 'doc';
    const all: DocumentChunk[] = [];
    let   docIdx = 0;

    // 原子块（code/table/image）原样成块，不与散文混切——它们的边界本身就是语义边界。
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
    const { embeddings, failedBatches } = await embedBatches(inputs, opts.embed, { batchSize, concurrency, timeoutMs, maxRetries, signal: opts.signal });

    if (failedBatches.length > 0) opts.onBatchFailure?.(failedBatches);
    if (opts.signal?.aborted) return this.fallback(blks, opts, 'aborted');
    if (embeddings.length !== sents.length) return this.fallback(blks, opts, `embed count mismatch: ${embeddings.length}/${sents.length}`);

    const rawSims: number[] = [];
    for (let i = 0; i < embeddings.length - 1; i++) rawSims.push(cosineSimilarity(embeddings[i]!, embeddings[i + 1]!));

    // 零向量/维度不齐会让余弦产出 NaN；占比过半说明嵌入整体失真，与其切出垃圾
    // 不如降级。少量 NaN 由下面的中位数填充吸收。
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

interface EmbedBatchOpts { batchSize: number; concurrency: number; timeoutMs: number; maxRetries: number; signal?: AbortSignal }

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
export async function embedBatches(texts: string[], embed: CallEmbed, opts: EmbedBatchOpts): Promise<BatchResult> {
  const batches = chunk(texts, opts.batchSize);
  const failedBatches: BatchResult['failedBatches'] = [];
  if (batches.length === 0) return { embeddings: [], failedBatches };

  const concurrency = Math.max(1, Math.min(opts.concurrency, batches.length));
  const results: Array<{ ok: true; vec: number[][] } | { ok: false; err: Error; count: number }> = new Array(batches.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (i >= batches.length) return;
      const batch = batches[i]!;
      try {
        const vec = await embedWithRetry(batch, embed, { ...opts, batchIndex: i });
        results[i] = { ok: true, vec };
      } catch (err) {
        results[i] = { ok: false, err: toError(err), count: batch.length };
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
      if (r) failedBatches.push({ batchIndex: i, error: r.err.message, sentenceCount: r.count });
    }
  }
  return { embeddings, failedBatches };
}

/**
 * 单次 embed 尝试带独立超时；外部 abort 经 onAbort 传播进同一条取消链。
 * 退避 500ms·2^attempt；最终失败抛出统一文案的错误（cause 链保留原始错误）。
 */
async function embedWithRetry(texts: string[], embed: CallEmbed, opts: EmbedBatchOpts & { batchIndex: number }): Promise<number[][]> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new KnowledgeEmbedAbortedError(opts.signal.reason);
    }
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(new Error('Embedding request timed out')), opts.timeoutMs);
    const onAbort = (): void => ctrl.abort(opts.signal!.reason);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res  = await embed({ texts, signal: ctrl.signal });
      clearTimeout(tid); opts.signal?.removeEventListener('abort', onAbort);
      return res.embeddings.map((embedding) => [...embedding]);
    } catch (err) {
      clearTimeout(tid); opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) {
        throw new KnowledgeEmbedAbortedError(opts.signal.reason ?? err);
      }
      lastErr = toError(err);
      if (attempt < opts.maxRetries) await sleep(500 * 2 ** attempt, opts.signal);
    }
  }
  throw new KnowledgeEmbedBatchError(opts.batchIndex, lastErr);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) { rej(signal.reason); return; }
    const id = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(id); rej(signal!.reason); }, { once: true });
  });
}

/** 语义组超 maxTokens 时按预算顺次切成多段；单句本身就超预算时原样成块（不拆句）。 */
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
