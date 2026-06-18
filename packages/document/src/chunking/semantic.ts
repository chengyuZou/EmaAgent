/**
 * Semantic chunker using embedding-based similarity to detect topic boundaries.
 *
 * Algorithm:
 *   1. Separate atomic elements (code/table/image) — each becomes its own chunk.
 *   2. Split remaining text elements into sentences.
 *   3. Embed sentences in batches (with optional buffer-window context).
 *   4. Compute cosine similarity between adjacent embeddings.
 *   5. Smooth the similarity curve with a rolling average.
 *   6. Identify breakpoints where similarity drops below threshold
 *      (fixed or percentile-derived).
 *   7. Group sentences at breakpoints, enforce token budget, merge tiny groups.
 *   8. Build Chunk objects and wire prev/next links.
 *
 * Failure modes handled:
 *   - embedFn network failure → retry with exponential backoff
 *   - embedFn timeout → abort via AbortController, retry or fallback
 *   - External AbortSignal → propagate immediately, no retry
 *   - Wrong vector count returned → EmbeddingCallError (non-retryable)
 *   - Zero-vector / NaN similarity → replace with finite median, continue
 *   - NaN saturation > MAX_NAN_FRACTION → fall back to SentenceChunker
 *   - Embedding dimension mismatch between vectors → cosineSimilarity returns NaN safely
 *   - Sentence array too short to compare → fall back to tokenChunk
 *   - Single sentence larger than maxTokens → emitted alone (never dropped)
 */

import { estimateTextTokens } from '@ema-agent/token';
import type { EbdRouter } from '@ema-agent/ebd-client';
import type { Chunk, Element } from '../types.js';
import type { ChunkOptions } from './base.js';
import { DEFAULT_CHUNK_OPTIONS, chunkId, linkChunks } from './base.js';
import { tokenChunk } from './token.js';
import { SentenceChunker } from './sentence.js';
import {
  splitSentences,
  cosineSimilarity,
  smoothSimilarities,
  percentile,
} from '../utils/sentences.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface SemanticChunkOptions extends ChunkOptions {
  /** EbdRouter instance for embedding calls. */
  ebdRouter:  EbdRouter;
  /** provider_configs.id to use for embedding. */
  providerId: string;
  /** Embedding model identifier. */
  model:      string;

  /**
   * Fixed cosine similarity threshold below which a boundary is inserted.
   * Default 0.5. Ignored when `breakPercentile` is set.
   * Lower values → fewer, larger chunks. Higher values → more, smaller chunks.
   */
  breakThreshold?: number;

  /**
   * Percentile-based threshold: the bottom N% of similarity values become
   * breakpoints. E.g. 25 → roughly 25% of sentence transitions are boundaries.
   * Takes precedence over `breakThreshold` when set.
   */
  breakPercentile?: number;

  /**
   * Rolling-average window size applied to the similarity array before
   * breakpoint detection. Reduces noise from individual sentence variance.
   * Default 3. Set to 1 to disable smoothing.
   */
  smoothWindow?: number;

  /**
   * Number of adjacent sentences included in the context window when building
   * each sentence's embedding input text. bufferSize=1 (default) means each
   * embedding input is sentence[i-1] + sentence[i] + sentence[i+1], giving
   * richer embeddings for short sentences.
   * Set to 0 to embed individual sentences only.
   */
  bufferSize?: number;

  /** Maximum sentences per embed batch (API call). Default 32. */
  batchSize?: number;

  /**
   * Hard cap on sentences per semantic group before applying token-budget
   * splitting. Prevents runaway groups when similarity stays high throughout.
   * Default 50.
   */
  maxSentencesPerGroup?: number;

  /** Per-batch embed timeout in milliseconds. Default 30 000. */
  timeoutMs?: number;

  /**
   * Retry attempts per batch on transient failures (network error, timeout).
   * Retries use exponential backoff starting at 500 ms.
   * Validation errors and user-initiated aborts are never retried.
   * Default 2.
   */
  maxRetries?: number;

  /** External cancellation signal. Propagated to each embed batch. */
  signal?: AbortSignal;

  /**
   * Called for each batch that fails after all retries, before the NaN
   * saturation check decides whether to fall back. Non-fatal — lets callers
   * surface partial failures without necessarily triggering a full fallback.
   */
  onBatchFailure?: (failures: Array<{ batchIndex: number; error: string; sentenceCount: number }>) => void;

  /**
   * Optional callback invoked when semantic chunking falls back to
   * SentenceChunker. Fallback is non-fatal — chunks are still produced.
   * Use this for telemetry or logging.
   */
  onFallback?: (warn: SemanticFallbackWarning) => void;
}

// ── Error types ───────────────────────────────────────────────────────────────

/**
 * Thrown when an embedding batch fails after all retries, or when the
 * embedFn returns an invalid response (wrong count, non-array, etc.).
 */
export class EmbeddingCallError extends Error {
  readonly retryable: boolean;
  readonly batchIndex: number;
  override readonly cause: unknown;

  constructor(
    message: string,
    opts: { cause: unknown; retryable: boolean; batchIndex: number },
  ) {
    super(message);
    this.name       = 'EmbeddingCallError';
    this.cause      = opts.cause;
    this.retryable  = opts.retryable;
    this.batchIndex = opts.batchIndex;
  }
}

/**
 * Passed to `onFallback` when semantic chunking cannot proceed and falls back
 * to SentenceChunker. Not thrown — only used as a notification.
 */
export class SemanticFallbackWarning extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`SemanticChunker fell back to sentence-boundary chunking: ${reason}`);
    this.name   = 'SemanticFallbackWarning';
    this.reason = reason;
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ATOMIC_KINDS             = new Set<Element['kind']>(['code', 'table', 'image']);
const DEFAULT_BREAK_THRESHOLD  = 0.5;
const DEFAULT_SMOOTH_WINDOW    = 3;
const DEFAULT_BUFFER_SIZE      = 1;
const DEFAULT_BATCH_SIZE       = 32;
const DEFAULT_MAX_SENT_GROUP   = 50;
const DEFAULT_TIMEOUT_MS       = 30_000;
const DEFAULT_MAX_RETRIES      = 2;
/** Max fraction of NaN similarities before we give up and fall back. */
const MAX_NAN_FRACTION         = 0.5;

// ── Main class ────────────────────────────────────────────────────────────────

export class SemanticChunker {
  /**
   * Chunk elements semantically. `opts.embedFn` is required.
   *
   * When embedding fails or the document is too short for semantic analysis,
   * automatically falls back to SentenceChunker and calls `opts.onFallback`.
   */
  async chunk(
    elements: Element[],
    opts: SemanticChunkOptions,
  ): Promise<Chunk[]> {
    if (elements.length === 0) return [];

    const runs   = segmentRuns(elements);
    const all:   Chunk[] = [];
    let   docIdx = 0;

    for (const run of runs) {
      if (run.type === 'atomic') {
        all.push(makeAtomicChunk(run.el, chunkId('doc', docIdx++)));
        continue;
      }

      const textChunks = await this.chunkTextRun(run.els, opts, docIdx);
      docIdx += textChunks.length;
      all.push(...textChunks);
    }

    linkChunks(all);
    return all;
  }

  // ── Text-run processing ───────────────────────────────────────────────────

  private async chunkTextRun(
    elements: Element[],
    opts:     SemanticChunkOptions,
    startIdx: number,
  ): Promise<Chunk[]> {
    const batchSize        = opts.batchSize            ?? DEFAULT_BATCH_SIZE;
    const smoothWindow     = opts.smoothWindow         ?? DEFAULT_SMOOTH_WINDOW;
    const bufferSize       = opts.bufferSize           ?? DEFAULT_BUFFER_SIZE;
    const maxSentPerGroup  = opts.maxSentencesPerGroup ?? DEFAULT_MAX_SENT_GROUP;
    const breakThreshold   = opts.breakThreshold       ?? DEFAULT_BREAK_THRESHOLD;
    const timeoutMs        = opts.timeoutMs            ?? DEFAULT_TIMEOUT_MS;
    const maxRetries       = opts.maxRetries           ?? DEFAULT_MAX_RETRIES;

    // ── Step 1: sentence extraction ─────────────────────────────────────────
    type SentWithEl = { text: string; el: Element };
    const sentences: SentWithEl[] = [];

    for (const el of elements) {
      const parts = splitSentences(el.text);
      for (const p of parts) {
        if (p.trim()) sentences.push({ text: p, el });
      }
    }

    if (sentences.length < 2) {
      // Not enough sentences for similarity comparisons
      return tokenChunk(elements, opts, `doc-${startIdx}`);
    }

    // ── Step 2: build buffer-window embedding inputs ─────────────────────────
    const rawTexts    = sentences.map(s => s.text);
    const embedInputs = buildBufferWindowTexts(rawTexts, bufferSize);

    // ── Step 3: embed with retry/timeout (parallel batches, partial-failure ok)
    const { embeddings, failedBatches } = await embedAllInBatches(embedInputs, opts.ebdRouter, {
      providerId: opts.providerId,
      model:      opts.model,
      batchSize,
      timeoutMs,
      maxRetries,
      signal:     opts.signal,
    });

    if (failedBatches.length > 0) {
      opts.onBatchFailure?.(failedBatches);
    }

    // Abort-propagation: if the caller cancelled, stop immediately
    if (opts.signal?.aborted) {
      return this.fallback(elements, opts, 'aborted by caller');
    }

    // ── Step 4: validate total count ─────────────────────────────────────────
    if (embeddings.length !== sentences.length) {
      return this.fallback(
        elements,
        opts,
        `embed returned ${embeddings.length} vectors for ${sentences.length} sentences`,
      );
    }

    // ── Step 5: compute pairwise similarities ─────────────────────────────────
    const rawSims: number[] = [];
    for (let i = 0; i < embeddings.length - 1; i++) {
      rawSims.push(cosineSimilarity(embeddings[i]!, embeddings[i + 1]!));
    }

    // ── Step 6: NaN saturation check ─────────────────────────────────────────
    const nanCount = rawSims.filter(s => Number.isNaN(s)).length;
    if (rawSims.length > 0 && nanCount / rawSims.length > MAX_NAN_FRACTION) {
      return this.fallback(
        elements,
        opts,
        `${nanCount}/${rawSims.length} similarities are NaN (likely zero-vector embeddings)`,
      );
    }

    // Replace remaining NaN with finite median so they don't create spurious breaks
    const finiteMedian = computeFiniteMedian(rawSims);
    const filledSims   = rawSims.map(s => (Number.isNaN(s) ? finiteMedian : s));

    // ── Step 7: smooth ────────────────────────────────────────────────────────
    const smoothed = smoothSimilarities(filledSims, smoothWindow);

    // ── Step 8: threshold ─────────────────────────────────────────────────────
    const threshold = opts.breakPercentile != null
      ? percentile(smoothed, opts.breakPercentile)
      : breakThreshold;

    // ── Step 9: find breakpoints ──────────────────────────────────────────────
    const breakpoints = new Set<number>(); // sentence index after which a break occurs
    for (let i = 0; i < smoothed.length; i++) {
      const sim = smoothed[i]!;
      if (Number.isFinite(sim) && sim < threshold) breakpoints.add(i);
    }

    // Hard cap: break every maxSentPerGroup sentences regardless of similarity
    for (let i = maxSentPerGroup - 1; i < sentences.length - 1; i += maxSentPerGroup) {
      breakpoints.add(i);
    }

    // ── Step 10: build groups ─────────────────────────────────────────────────
    const groups: SentWithEl[][] = [];
    let   group:  SentWithEl[]   = [];
    for (let i = 0; i < sentences.length; i++) {
      group.push(sentences[i]!);
      if (breakpoints.has(i)) { groups.push(group); group = []; }
    }
    if (group.length > 0) groups.push(group);

    // ── Step 11: build Chunk objects ──────────────────────────────────────────
    const chunks: Chunk[] = [];
    let   idx             = startIdx;

    for (const grp of groups) {
      const text    = grp.map(s => s.text).join(' ').trim();
      const tokens  = estimateTextTokens(text);
      const firstEl = grp[0]!.el;

      if (tokens <= opts.maxTokens) {
        if (tokens < opts.minTokens && chunks.length > 0) {
          // Merge tiny tail into previous chunk
          const prev     = chunks[chunks.length - 1]!;
          prev.text      += ' ' + text;
          prev.tokenCount = estimateTextTokens(prev.text);
        } else {
          chunks.push(makeTextChunk(chunkId('doc', idx++), text, firstEl));
        }
      } else {
        // Group exceeds token budget: split at sentence boundaries
        const sub = splitGroupByBudget(grp, opts, idx);
        idx      += sub.length;
        chunks.push(...sub);
      }
    }

    return chunks;
  }

  private async fallback(
    elements: Element[],
    opts:     SemanticChunkOptions,
    reason:   string,
  ): Promise<Chunk[]> {
    opts.onFallback?.(new SemanticFallbackWarning(reason));
    return new SentenceChunker().chunk(elements, opts);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

type Run =
  | { type: 'atomic'; el: Element }
  | { type: 'text';   els: Element[] };

function segmentRuns(elements: Element[]): Run[] {
  const runs:     Run[]     = [];
  let   textBuf:  Element[] = [];

  const flushText = (): void => {
    if (textBuf.length > 0) { runs.push({ type: 'text', els: textBuf }); textBuf = []; }
  };

  for (const el of elements) {
    if (ATOMIC_KINDS.has(el.kind)) { flushText(); runs.push({ type: 'atomic', el }); }
    else                           { textBuf.push(el); }
  }
  flushText();
  return runs;
}

function makeAtomicChunk(el: Element, id: string): Chunk {
  const text = el.markdown ?? el.text;
  return {
    id,
    text,
    ...(el.markdown ? { markdown: el.markdown } : {}),
    elementKinds: [el.kind],
    tokenCount:   estimateTextTokens(text),
    source: {
      fileName:    '',
      mimeType:    '',
      page:        el.page,
      sectionPath: el.sectionPath,
    },
  };
}

function makeTextChunk(id: string, text: string, el: Element): Chunk {
  return {
    id,
    text,
    elementKinds: ['paragraph'],
    tokenCount:   estimateTextTokens(text),
    source: {
      fileName:    '',
      mimeType:    '',
      page:        el.page,
      sectionPath: el.sectionPath,
    },
  };
}

/**
 * Build buffer-window embedding inputs.
 * For sentence i, concatenate sentences[i-bufferSize .. i .. i+bufferSize].
 * Short sentences get richer context; edge sentences are clamped to array bounds.
 */
function buildBufferWindowTexts(sentences: string[], bufferSize: number): string[] {
  if (bufferSize <= 0) return sentences;
  return sentences.map((_, i) => {
    const lo = Math.max(0, i - bufferSize);
    const hi = Math.min(sentences.length - 1, i + bufferSize);
    return sentences.slice(lo, hi + 1).join(' ');
  });
}

interface BatchEmbedResult {
  embeddings: number[][];
  failedBatches: Array<{ batchIndex: number; error: string; sentenceCount: number }>;
}

/**
 * Embed all texts in parallel batches. Uses Promise.allSettled so a single
 * failing batch does not abort the rest. Failed batches are filled with empty
 * vectors — NaN saturation detection in the caller decides whether to fallback.
 */
async function embedAllInBatches(
  texts:     string[],
  ebdRouter: EbdRouter,
  opts: {
    providerId: string;
    model:      string;
    batchSize:  number;
    timeoutMs:  number;
    maxRetries: number;
    signal?:    AbortSignal;
  },
): Promise<BatchEmbedResult> {
  const batches = batchArray(texts, opts.batchSize);

  const settled = await Promise.allSettled(
    batches.map((batch, batchIdx) =>
      embedBatchWithRetry(batch, ebdRouter, { ...opts, batchIndex: batchIdx }),
    ),
  );

  const embeddings: number[][] = [];
  const failedBatches: BatchEmbedResult['failedBatches'] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    const batch  = batches[i]!;
    if (result.status === 'fulfilled') {
      embeddings.push(...result.value);
    } else {
      // Fill with empty vectors — cosineSimilarity returns NaN for [],
      // which flows through NaN saturation logic in the caller.
      for (let j = 0; j < batch.length; j++) embeddings.push([]);
      failedBatches.push({
        batchIndex:    i,
        error:         result.reason instanceof Error ? result.reason.message : String(result.reason),
        sentenceCount: batch.length,
      });
    }
  }

  return { embeddings, failedBatches };
}

async function embedBatchWithRetry(
  texts:     string[],
  ebdRouter: EbdRouter,
  opts: {
    providerId: string;
    model:      string;
    timeoutMs:  number;
    maxRetries: number;
    signal?:    AbortSignal;
    batchIndex: number;
  },
): Promise<number[][]> {
  let lastErr: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new EmbeddingCallError('Embedding aborted by caller', {
        cause:      opts.signal.reason,
        retryable:  false,
        batchIndex: opts.batchIndex,
      });
    }

    const controller = new AbortController();
    const timeoutId  = setTimeout(
      () => controller.abort(new Error(
        `Embed batch ${opts.batchIndex} timed out after ${opts.timeoutMs} ms`,
      )),
      opts.timeoutMs,
    );

    const onExtAbort = (): void => controller.abort(opts.signal!.reason);
    opts.signal?.addEventListener('abort', onExtAbort, { once: true });

    try {
      const res = await ebdRouter.embed({
        providerId: opts.providerId,
        model:      opts.model,
        texts,
        signal:     controller.signal,
      });
      clearTimeout(timeoutId);
      opts.signal?.removeEventListener('abort', onExtAbort);

      const vecs = res.embeddings;

      if (vecs.length !== texts.length) {
        throw new EmbeddingCallError(
          `embed returned ${vecs.length} vectors for ${texts.length} inputs (batch ${opts.batchIndex})`,
          { cause: null, retryable: false, batchIndex: opts.batchIndex },
        );
      }

      for (let i = 0; i < vecs.length; i++) {
        const v = vecs[i];
        if (!Array.isArray(v) || v.length === 0) {
          throw new EmbeddingCallError(
            `embed returned invalid vector at position ${i} in batch ${opts.batchIndex} ` +
            `(got ${Array.isArray(v) ? 'empty array' : typeof v})`,
            { cause: null, retryable: false, batchIndex: opts.batchIndex },
          );
        }
        if (res.dim > 0 && v.length !== res.dim) {
          throw new EmbeddingCallError(
            `embed vector ${i} has length ${v.length}, expected dim ${res.dim} (batch ${opts.batchIndex})`,
            { cause: null, retryable: false, batchIndex: opts.batchIndex },
          );
        }
      }

      return vecs;
    } catch (err) {
      clearTimeout(timeoutId);
      opts.signal?.removeEventListener('abort', onExtAbort);
      lastErr = err;

      if (opts.signal?.aborted) {
        throw new EmbeddingCallError('Embedding aborted by caller', {
          cause:      err,
          retryable:  false,
          batchIndex: opts.batchIndex,
        });
      }

      if (err instanceof EmbeddingCallError && !err.retryable) throw err;

      if (attempt < opts.maxRetries) {
        await sleepInterruptible(500 * 2 ** attempt, opts.signal);
      }
    }
  }

  throw new EmbeddingCallError(
    `Embed batch ${opts.batchIndex} failed after ${opts.maxRetries + 1} attempt(s)`,
    { cause: lastErr, retryable: false, batchIndex: opts.batchIndex },
  );
}

function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => { clearTimeout(id); reject(signal.reason); },
      { once: true },
    );
  });
}

/** Split a sentence group into sub-chunks that each fit within maxTokens. */
function splitGroupByBudget(
  sentences: { text: string; el: Element }[],
  opts:      ChunkOptions,
  startIdx:  number,
): Chunk[] {
  const chunks: Chunk[] = [];
  let   buf:    { text: string; el: Element }[] = [];
  let   bufToks = 0;
  let   idx     = startIdx;

  const flush = (): void => {
    if (buf.length === 0) return;
    const text    = buf.map(s => s.text).join(' ').trim();
    const firstEl = buf[0]!.el;
    buf    = [];
    bufToks = 0;
    if (text) chunks.push(makeTextChunk(chunkId('doc', idx++), text, firstEl));
  };

  for (const sent of sentences) {
    const toks = estimateTextTokens(sent.text);
    // Single sentence exceeds budget: emit alone (never drop)
    if (toks > opts.maxTokens) { flush(); chunks.push(makeTextChunk(chunkId('doc', idx++), sent.text, sent.el)); continue; }
    if (bufToks + toks > opts.maxTokens) flush();
    buf.push(sent);
    bufToks += toks;
  }
  flush();
  return chunks;
}

/** Split an array into sub-arrays of at most `size` elements. */
function batchArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function computeFiniteMedian(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0.5;
  return sorted[Math.floor(sorted.length / 2)]!;
}

// Re-export for convenience
export { DEFAULT_CHUNK_OPTIONS };
