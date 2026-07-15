import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type {
  DocumentAsset,
  DocumentChunk,
  IngestFailureShard,
  IngestItemCounts,
  IngestOptions,
  IngestResult,
} from '../types.js';
import { EXT_TO_MIME, parseDocument } from '../parse/index.js';
import { buildPreview } from '../preview/index.js';
import { validateFile } from './validate.js';
import { planIngest } from './plan.js';
import { RecursiveChunker } from '../chunking/recursive.js';
import { SemanticChunker } from '../chunking/semantic.js';
import { assignParents } from '../chunking/base.js';
import { ImageReader } from '../readers/image.js';
import type { KnowledgeStore } from '../store/index.js';
import type { DocumentEventEmitter } from '../events/emitter.js';
import type { DocumentProgressEvent } from '../events/types.js';
import type { KbVisionAdapter } from '../adapters/vision.js';
import type { EbdRouter, EmbeddingSpace } from '@ema-agent/ebd-client';

const EMBED_BATCH_SIZE = 32;

export interface IngestDeps {
  store:          KnowledgeStore;
  events:         DocumentEventEmitter;
  ebdRouter?:     EbdRouter;
  visionAdapter?: KbVisionAdapter;
}

interface EmbeddingReport {
  space?: EmbeddingSpace;
  failures: IngestFailureShard[];
  counts: IngestItemCounts;
}

export async function ingest(
  filePath: string,
  opts: IngestOptions,
  deps: IngestDeps,
): Promise<IngestResult> {
  const assetId = opts.assetId ?? randomUUID();
  if (opts.retryChunkIds && opts.retryChunkIds.length > 0) {
    return retryFailedEmbeddings(assetId, opts, deps);
  }

  const { store, ebdRouter, visionAdapter } = deps;
  const emit = createProgressEmitter(assetId, opts, deps.events);

  // 失败后的完整重试必须先删除旧的中间产物。文档、chunk、preview 通过 FK
  // 一次清理，避免新解析结果与上一轮残留 chunk 混合。
  const sameIdAsset = store.getAsset(assetId);
  if (sameIdAsset) {
    if (sameIdAsset.status !== 'error' && !opts.replaceExistingAsset) {
      throw new Error(`[kb/ingest] asset ${assetId} already exists with status ${sameIdAsset.status}`);
    }
    store.deleteAsset(assetId);
  }

  // ── 1. Read + validate ────────────────────────────────────────────────────
  const bytes = new Uint8Array(await readFile(filePath));
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = opts.mimeType ?? EXT_TO_MIME[ext] ?? 'text/plain';

  emit({ kind: 'validate' });
  const validation = validateFile(bytes, mimeType);
  if (!validation.ok) throw new Error(`[kb/ingest] validation failed: ${validation.error}`);

  // ── 2. Deduplication ──────────────────────────────────────────────────────
  const existing = validation.hash ? store.findAssetByHash(validation.hash) : undefined;
  if (existing && existing.status !== 'error') {
    const result = buildDuplicateResult(existing, store);
    emit({ kind: 'complete', progress: 1, ...eventCounts(result.counts) });
    return result;
  }

  // ── 3. Store asset (indexing) ─────────────────────────────────────────────
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const asset: DocumentAsset = {
    id: assetId,
    filePath,
    fileName,
    mimeType,
    title: undefined,
    wordCount: 0,
    pageCount: undefined,
    contentHash: validation.hash,
    status: 'indexing',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    useCount: 0,
    lastActivatedAt: undefined,
  };
  store.addAsset(asset);

  try {
    // ── 4. Parse ────────────────────────────────────────────────────────────
    emit({ kind: 'parse' });
    const ocrReader = visionAdapter && opts.visionProviderId && opts.visionModel
      ? new ImageReader(visionAdapter, {
          providerId: opts.visionProviderId,
          model: opts.visionModel,
          signal: opts.signal,
        })
      : undefined;

    const parsed = await parseDocument(
      { kind: 'bytes', bytes, name: fileName },
      {
        mimeType,
        imageReader: mimeType.startsWith('image/') ? ocrReader : undefined,
        pdfOcrReader: mimeType === 'application/pdf' ? ocrReader : undefined,
      },
    );

    if (parsed.title || parsed.wordCount || parsed.pageCount) {
      store.patchAssetMeta(assetId, {
        title: parsed.title,
        wordCount: parsed.wordCount,
        pageCount: parsed.pageCount,
      });
    }

    // ── 5. Chunk ────────────────────────────────────────────────────────────
    emit({ kind: 'chunk' });
    const plan = planIngest(mimeType, !!(ebdRouter && opts.ebdProviderId && opts.ebdModel));
    const chunkOpts = { maxTokens: 512, overlap: 64, minTokens: 20, assetId };
    const rawChunks = plan.useSemanticChunking && ebdRouter && opts.ebdProviderId && opts.ebdModel
      ? await new SemanticChunker().chunk(parsed.blocks, {
          ...chunkOpts,
          ebdRouter,
          providerId: opts.ebdProviderId,
          model: opts.ebdModel,
          signal: opts.signal,
        })
      : await new RecursiveChunker().chunk(parsed.blocks, chunkOpts);

    const chunks = rawChunks.map(chunk => ({ ...chunk, assetId }));
    assignParents(chunks, chunkOpts.maxTokens * 4);
    store.addChunks(chunks);

    // ── 6. Embed ────────────────────────────────────────────────────────────
    let embeddingReport: EmbeddingReport = {
      failures: [],
      counts: { total: chunks.length, completed: chunks.length, failed: 0 },
    };
    if (ebdRouter && opts.ebdProviderId && opts.ebdModel && chunks.length > 0) {
      emit({ kind: 'embed', progress: 0 });
      embeddingReport = await embedChunks(chunks, ebdRouter, opts, store, emit);
      // 即便部分失败，也登记成功批次所属空间，使这些向量可以参与检索；
      // failedItems 明确告诉上层当前索引并不完整。
      if (embeddingReport.space) store.setEmbeddingSpace(assetId, embeddingReport.space);
    }

    // ── 7. Preview ──────────────────────────────────────────────────────────
    const preview = await buildPreview(parsed.blocks, {
      assetId,
      mimeType,
      bytes,
      pageCount: parsed.pageCount,
    });
    store.addPreview(preview);

    // ── 8. Mark indexed / partial ───────────────────────────────────────────
    store.updateStatus(assetId, 'indexed');
    const parseFailures: IngestFailureShard[] = parsed.failures.map(failure => ({
      stage: 'parse',
      ...failure,
    }));
    const failureShards = [...parseFailures, ...embeddingReport.failures];
    const counts = combineIngestCounts(
      embeddingReport.counts,
      parsed.pageCount,
      parseFailures.length,
    );
    const outcome = failureShards.length > 0 ? 'partial_failed' : 'completed';
    emit({
      kind: outcome === 'completed' ? 'complete' : 'partial_failed',
      progress: 1,
      ...(outcome === 'partial_failed'
        ? { error: `${counts.failed} 个页面或 chunk 处理失败` }
        : {}),
      ...eventCounts(counts),
    });

    return {
      asset: {
        ...asset,
        title: parsed.title,
        wordCount: parsed.wordCount,
        pageCount: parsed.pageCount,
        status: 'indexed',
        updatedAt: Date.now(),
      },
      chunks: chunks.length,
      preview,
      outcome,
      counts,
      failureShards,
    };
  } catch (error) {
    store.updateStatus(assetId, 'error');
    emit({ kind: 'error', error: errorMessage(error) });
    throw error;
  }
}

async function retryFailedEmbeddings(
  assetId: string,
  opts: IngestOptions,
  deps: IngestDeps,
): Promise<IngestResult> {
  const { store, ebdRouter } = deps;
  const emit = createProgressEmitter(assetId, opts, deps.events);
  if (!ebdRouter || !opts.ebdProviderId || !opts.ebdModel) {
    throw new Error('[kb/ingest] embedding provider is required for partial retry');
  }

  const asset = store.getAsset(assetId);
  const preview = store.getPreview(assetId);
  if (!asset || !preview) throw new Error(`[kb/ingest] partial asset ${assetId} not found`);

  const requestedIds = [...new Set(opts.retryChunkIds ?? [])];
  const chunks = store.getChunksByIds(assetId, requestedIds);
  if (chunks.length !== requestedIds.length) {
    throw new Error('[kb/ingest] failed chunk set no longer matches persisted document');
  }

  emit({ kind: 'embed', progress: 0 });
  const report = await embedChunks(chunks, ebdRouter, opts, store, emit, asset.ebdSpaceId);
  const effectiveSpace = report.space;
  if (effectiveSpace) store.setEmbeddingSpace(assetId, effectiveSpace);

  const spaceId = effectiveSpace?.id ?? asset.ebdSpaceId;
  if (!spaceId) {
    const failures = report.failures.length > 0
      ? report.failures
      : [{
          stage: 'embed' as const,
          shardKey: 'embed:space-unresolved',
          itemIds: requestedIds,
          retryable: true,
          errorCode: 'kb/embed-space-unresolved',
          error: 'Embedding 空间未确定',
        }];
    const counts = { total: requestedIds.length, completed: 0, failed: requestedIds.length };
    emit({ kind: 'partial_failed', progress: 1, error: failures[0]!.error, ...eventCounts(counts) });
    return { asset, chunks: store.getChunks(assetId).length, preview, outcome: 'partial_failed', counts, failureShards: failures };
  }

  const missingIds = store.findMissingEmbeddingIds(assetId, spaceId);
  const totalChunks = store.embeddingCoverage(assetId, spaceId).total;
  const counts = {
    total: totalChunks,
    completed: totalChunks - missingIds.length,
    failed: missingIds.length,
  };
  const failures = missingIds.length > 0
    ? mergeMissingFailures(report.failures, missingIds)
    : [];
  const outcome = failures.length > 0 ? 'partial_failed' : 'completed';
  emit({
    kind: outcome === 'completed' ? 'complete' : 'partial_failed',
    progress: 1,
    ...(outcome === 'partial_failed' ? { error: `${missingIds.length} 个 chunk 仍缺少向量` } : {}),
    ...eventCounts(counts),
  });
  return {
    asset: store.getAsset(assetId) ?? asset,
    chunks: totalChunks,
    preview,
    outcome,
    counts,
    failureShards: failures,
  };
}

async function embedChunks(
  chunks: DocumentChunk[],
  router: EbdRouter,
  opts: IngestOptions,
  store: KnowledgeStore,
  emit: (event: Omit<DocumentProgressEvent, 'assetId' | 'taskId' | 'attempt'>) => void,
  expectedSpaceId?: string,
): Promise<EmbeddingReport> {
  let space: EmbeddingSpace | undefined;
  const failures: IngestFailureShard[] = [];
  let completed = 0;

  for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
    try {
      const response = await router.embed({
        providerId: opts.ebdProviderId!,
        model: opts.ebdModel!,
        texts: batch.map(chunk => chunk.text),
        signal: opts.signal,
      });
      const requiredSpace = space?.id ?? expectedSpaceId;
      if (requiredSpace && requiredSpace !== response.space.id) {
        throw new Error(
          `Embedding space changed during ingest: ${requiredSpace} -> ${response.space.id}`,
        );
      }
      validateEmbeddingBatch(batch, response.embeddings);
      space = response.space;
      // 先完整校验，再原子语义地写这一批；避免半批成功后才发现数量不一致。
      for (let index = 0; index < batch.length; index++) {
        store.storeEmbedding(batch[index]!.id, response.embeddings[index]!, response.space.id);
      }
      completed += batch.length;
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (errorMessage(error).startsWith('Embedding space changed during ingest')) throw error;
      failures.push({
        stage: 'embed',
        shardKey: `embed:${Math.floor(offset / EMBED_BATCH_SIZE)}`,
        itemIds: batch.map(chunk => chunk.id),
        retryable: true,
        errorCode: 'kb/embed-batch-failed',
        error: errorMessage(error),
      });
    }
    emit({
      kind: 'embed',
      progress: Math.min((offset + batch.length) / chunks.length, 1),
      totalItems: chunks.length,
      completedItems: completed,
      failedItems: failures.reduce((sum, failure) => sum + failure.itemIds.length, 0),
    });
  }

  const failed = failures.reduce((sum, failure) => sum + failure.itemIds.length, 0);
  return {
    space,
    failures,
    counts: { total: chunks.length, completed, failed },
  };
}

function validateEmbeddingBatch(chunks: DocumentChunk[], embeddings: number[][]): void {
  if (embeddings.length !== chunks.length) {
    throw new Error(`Embedding count mismatch: expected ${chunks.length}, received ${embeddings.length}`);
  }
  const dim = embeddings[0]?.length ?? 0;
  if (dim <= 0) throw new Error('Embedding provider returned an empty vector');
  for (let index = 0; index < embeddings.length; index++) {
    const vector = embeddings[index]!;
    if (vector.length !== dim || vector.some(value => !Number.isFinite(value))) {
      throw new Error(`Invalid embedding vector at batch index ${index}`);
    }
  }
}

function createProgressEmitter(
  assetId: string,
  opts: IngestOptions,
  events: DocumentEventEmitter,
): (event: Omit<DocumentProgressEvent, 'assetId' | 'taskId' | 'attempt'>) => void {
  return event => events.emit({
    assetId,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.attempt !== undefined ? { attempt: opts.attempt } : {}),
    ...event,
  });
}

function eventCounts(counts: IngestItemCounts): Pick<
  DocumentProgressEvent,
  'totalItems' | 'completedItems' | 'failedItems'
> {
  return {
    totalItems: counts.total,
    completedItems: counts.completed,
    failedItems: counts.failed,
  };
}

function combineIngestCounts(
  embedding: IngestItemCounts,
  pageCount: number | undefined,
  failedPages: number,
): IngestItemCounts {
  if (pageCount === undefined) return embedding;
  return {
    total: embedding.total + pageCount,
    completed: embedding.completed + Math.max(0, pageCount - failedPages),
    failed: embedding.failed + failedPages,
  };
}

function mergeMissingFailures(
  failures: IngestFailureShard[],
  missingIds: string[],
): IngestFailureShard[] {
  const reported = new Set(failures.flatMap(failure => failure.itemIds));
  const unreported = missingIds.filter(id => !reported.has(id));
  if (unreported.length === 0) return failures;
  return [
    ...failures,
    {
      stage: 'embed',
      shardKey: 'embed:missing-after-retry',
      itemIds: unreported,
      retryable: true,
      errorCode: 'kb/embed-missing',
      error: '重试结束后仍有 chunk 缺少当前空间的向量',
    },
  ];
}

function buildDuplicateResult(existing: DocumentAsset, store: KnowledgeStore): IngestResult {
  const chunks = store.getChunks(existing.id).length;
  const preview = store.getPreview(existing.id) ?? {
    assetId: existing.id,
    text: '',
    wordCount: existing.wordCount,
    pageCount: existing.pageCount,
  };
  return {
    asset: existing,
    chunks,
    preview,
    outcome: 'completed',
    counts: { total: chunks, completed: chunks, failed: 0 },
    failureShards: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
