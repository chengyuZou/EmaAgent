// 负责知识库文档写入、重嵌入、混合检索与内存向量索引生命周期。

import type {
  DocumentAsset, DocumentChunk, DocumentPreview,
  IngestOptions, IngestResult, SearchOptions, AssetListPage,
} from './types.js';
import type { KbSearchResult, DocumentSourceRef } from '@ema-agent/contracts';
import type { EbdRouter, EmbeddingSpace } from '@ema-agent/ebd-client';
import type { ChunkPage, AssetUsage } from '@ema-agent/storage';
import { ingest as runIngest } from './ingest/index.js';
import type { KnowledgeStore } from './store/index.js';
import type { KbVisionAdapter } from './adapters/vision.js';
import type { KbHydeAdapter }   from './adapters/hyde.js';
import type { KbAutoQuestionAdapter } from './adapters/auto-questions.js';
import { DocumentEventEmitter } from './events/emitter.js';
import { weightedRank }         from './retrieval/hybrid.js';
import type { VectorIndex }     from './index/vector-index.js';
import { createVectorIndex }    from './index/factory.js';
import { normalizeF32 } from './embed/normalize.js';

// Reranker scores below this threshold indicate the document does not actually
// contain relevant content for the query. Filtering prevents cross-document
// pollution when the answer simply does not exist in the KB.
const MIN_RERANK_SCORE = 0.4;

export interface KnowledgeClientDeps {
  store:          KnowledgeStore;
  ebdRouter?:     EbdRouter;
  visionAdapter?: KbVisionAdapter;
  hydeAdapter?:   KbHydeAdapter;
  /** Index-time question generation (RAGFlow-style). Interface only — unwired in V1,
   *  pending a frontend/product decision on how questions feed embedding. */
  autoQuestionAdapter?: KbAutoQuestionAdapter;
}

export class KnowledgeClient {
  readonly events = new DocumentEventEmitter();

  // In-memory HNSW (or brute-force fallback). null until init() is called.
  private hnsw: VectorIndex | null = null;
  private hnswSpaceId: string | null = null;
  // chunkId → assetId, so HNSW hits can be filtered to the turn's selected docs.
  private readonly chunkToAsset = new Map<string, string>();

  constructor(private readonly deps: KnowledgeClientDeps) {}

  /**
   * Build the in-memory HNSW index from persisted BLOB embeddings.
   * Must be called once after construction (or after a reembed completes).
   * Safe to call again — clears and rebuilds the index.
   */
  async init(): Promise<void> {
    // 当前空间要由一次真实 embedding 响应确定，不能从旧行猜测。
    this.hnsw = null;
    this.hnswSpaceId = null;
    this.chunkToAsset.clear();
  }

  // ── Ingest ────────────────────────────────────────────────────────────────

  async ingest(filePath: string, opts: IngestOptions): Promise<IngestResult> {
    const result = await runIngest(filePath, opts, {
      store:         this.deps.store,
      events:        this.events,
      ebdRouter:     this.deps.ebdRouter,
      visionAdapter: this.deps.visionAdapter,
    });

    const stored = this.deps.store.getAsset(result.asset.id);
    if (stored?.ebdSpaceId && stored.ebdDim) {
      await this.rebuildIndex(stored.ebdSpaceId, stored.ebdDim);
    }

    return result;
  }

  private async rebuildIndex(spaceId: string, dim: number): Promise<void> {
    // 先在局部变量中完整构建，再一次替换当前索引。构建中失败时，搜索仍可
    // 使用上一份完整索引，不会观察到只写入一半的 HNSW 和映射表。
    const nextIndex = await createVectorIndex(dim);
    const nextChunkToAsset = new Map<string, string>();
    const rows = this.deps.store.getAllEmbeddings(spaceId);
    for (const { id, assetId, embedding } of rows) {
      const vec = normalizeF32(bufferToFloat32(embedding));
      nextIndex.add(id, vec);
      nextChunkToAsset.set(id, assetId);
    }
    this.hnsw = nextIndex;
    this.hnswSpaceId = spaceId;
    this.chunkToAsset.clear();
    for (const [chunkId, assetId] of nextChunkToAsset) {
      this.chunkToAsset.set(chunkId, assetId);
    }
  }

  private async ensureIndex(space: EmbeddingSpace): Promise<void> {
    // Provider 配置中的 revision 改变时前端未必能感知；真实响应是最终权威。
    this.deps.store.markStaleExcept(space.id);
    if (this.hnswSpaceId !== space.id || this.hnsw?.dim !== space.dim) {
      await this.rebuildIndex(space.id, space.dim);
    }
  }

  // ── Embedding model invalidation ──────────────────────────────────────────

  /**
   * Call this when the user switches embedding providers/models.
   * Marks all assets with a different model as stale in the DB and removes
   * their chunk vectors from the in-memory HNSW index.
   * Returns the number of assets marked stale.
   */
  invalidateEmbeddings(newSpaceId: string): number {
    const count = this.deps.store.markStaleExcept(newSpaceId);
    this.hnsw = null;
    this.hnswSpaceId = null;
    this.chunkToAsset.clear();
    return count;
  }

  /**
   * 由 ReembedQueue 驱动的重建扫描: 逐资产重嵌, 单资产失败只记账不中断整场。
   * Client 只发送逐资产进度事件并返回业务结果；终态落库和终态事件由
   * ReembedQueue 在 CAS 成功后统一发布，避免 SSE 与持久状态互相矛盾。
   */
  async reembedSweep(opts: {
    /** 缺省 = 全部 stale 资产; 有值 = 单文档重建。 */
    assetId?: string;
    ebdProviderId: string;
    ebdModel: string;
    taskId: string;
    attempt: number;
    signal: AbortSignal;
    onProgress?: (done: number, total: number, failed: number) => void;
  }): Promise<{
    total: number;
    done: number;
    failed: Array<{ assetId: string; error: string }>;
  }> {
    if (!this.deps.ebdRouter) throw new Error('未配置 Embedding Provider');

    const targets = opts.assetId
      ? [opts.assetId]
      : this.deps.store.listStaleAssets().map(asset => asset.id);
    const total = targets.length;
    let done = 0;
    const failed: Array<{ assetId: string; error: string }> = [];
    let resolvedSpace: EmbeddingSpace | undefined;

    for (const assetId of targets) {
      if (opts.signal.aborted) break;
      try {
        const assetSpace = await this.reembedAssetOrThrow(assetId, opts, resolvedSpace);
        resolvedSpace ??= assetSpace;
        done++;
      } catch (error) {
        failed.push({ assetId, error: error instanceof Error ? error.message : String(error) });
      }
      opts.onProgress?.(done, total, failed.length);
      this.events.emit({
        assetId,
        taskId: opts.taskId,
        attempt: opts.attempt,
        kind: 'embed',
        progress: total === 0 ? 1 : (done + failed.length) / total,
        totalItems: total,
        completedItems: done,
        failedItems: failed.length,
        operation: 'reembed',
      });
    }

    if (opts.signal.aborted) {
      // 已经写入 SQLite 的成功分片仍然正确，但旧内存索引可能与数据库不一致。
      // 取消时直接清空派生缓存，后续搜索按 SQL exact-space fallback 工作。
      this.hnsw = null;
      this.hnswSpaceId = null;
      this.chunkToAsset.clear();
      return { total, done, failed };
    }

    // 一场任务只重建一次索引。逐资产重建会导致同一空间的后续资产无法进入
    // 已存在的 HNSW；统一在所有成功资产落库后，从 SQLite 事实源完整重建。
    if (resolvedSpace) {
      this.deps.store.markStaleExcept(resolvedSpace.id);
      await this.rebuildIndex(resolvedSpace.id, resolvedSpace.dim);
    }
    return { total, done, failed };
  }

  /** 单资产重嵌, 失败原样抛出(由 sweep 逐资产捕获记账)。 */
  private async reembedAssetOrThrow(
    assetId: string,
    opts: { ebdProviderId: string; ebdModel: string; signal?: AbortSignal },
    expectedSpace?: EmbeddingSpace,
  ): Promise<EmbeddingSpace> {
    if (!this.deps.ebdRouter) throw new Error('未配置 Embedding Provider');
    const chunks = this.deps.store.getChunks(assetId);
    let space: EmbeddingSpace | undefined;
    const BATCH = 32;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const res = await this.deps.ebdRouter.embed({
        providerId: opts.ebdProviderId,
        model:      opts.ebdModel,
        texts:      batch.map(c => c.text),
        signal:     opts.signal,
      });
      if (expectedSpace && expectedSpace.id !== res.space.id) {
        throw new Error('Embedding space changed between assets during re-embed');
      }
      if (space && space.id !== res.space.id) throw new Error('Embedding space changed during re-embed');
      space = res.space;
      for (let j = 0; j < batch.length; j++) {
        const vec = res.embeddings[j];
        if (vec?.length) {
          this.deps.store.storeEmbedding(batch[j]!.id, vec, res.space.id);
        }
      }
    }
    if (!space) throw new Error('Embedding provider returned no space');
    this.deps.store.setEmbeddingSpace(assetId, space);
    return space;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async search(query: string, opts: SearchOptions = {}): Promise<KbSearchResult> {
    const topK  = opts.topK  ?? 10;
    const alpha = opts.alpha ?? 0.5;

    // Record this turn's KB selection (use_count + last_activated_at + kb_activations).
    if (opts.assetIds && opts.assetIds.length > 0) {
      this.deps.store.recordActivation(opts.assetIds, { sessionId: opts.sessionId, turnId: opts.turnId });
    }

    const searchOpts = { assetIds: opts.assetIds, topK: topK * 3 };
    const selected = opts.assetIds ? new Set(opts.assetIds) : null;

    const toRanked = (hits: Array<{ chunkId: string; score: number }>) =>
      hits.map(h => ({ id: h.chunkId, score: h.score }));

    // ── Sparse (FTS5 BM25, always available) ──────────────────────────────────
    const sparseHits = toRanked(this.deps.store.searchFts(query, searchOpts));

    // ── Dense (HNSW in-memory, falls back to SQL cosine when not initialised) ─
    let denseHits: typeof sparseHits = [];
    if (this.deps.ebdRouter && opts.ebdProviderId && opts.ebdModel) {
      try {
        // Optional HyDE: generate a hypothetical passage before embedding
        let embedQuery = query;
        if (this.deps.hydeAdapter) {
          try {
            embedQuery = await this.deps.hydeAdapter.generateHypoDoc(query, opts.signal);
          } catch {
            // HyDE failed — fall back to raw query
          }
        }

        const res = await this.deps.ebdRouter.embed({
          providerId: opts.ebdProviderId,
          model:      opts.ebdModel,
          texts:      [embedQuery],
          signal:     opts.signal,
        });
        const queryVec = res.embeddings[0];
        if (queryVec?.length) {
          await this.ensureIndex(res.space);
          if (this.hnsw) {
            // HNSW path: search with extra budget, then filter by scope
            const f32 = normalizeF32(new Float32Array(queryVec));
            const raw = this.hnsw.search(f32, topK * 6);
            denseHits = raw
              .filter(h => {
                const assetId = this.chunkToAsset.get(h.id);
                if (!assetId) return false;
                // Filter to the turn's selected KBs (null = all KBs).
                return selected ? selected.has(assetId) : true;
              })
              .slice(0, topK * 3)
              .map(h => ({ id: h.id, score: h.score }));
          } else {
            // Fallback: O(n) SQL cosine scan
            denseHits = toRanked(this.deps.store.searchByEmbedding(queryVec, res.space.id, searchOpts));
          }
        }
      } catch {
        // Embedding unavailable — fall back to sparse-only
      }
    }

    // ── Hybrid fusion ─────────────────────────────────────────────────────────
    let ranked = weightedRank(sparseHits, denseHits, alpha, topK * 2);

    // ── Optional rerank ───────────────────────────────────────────────────────
    if (this.deps.ebdRouter && opts.rerankProviderId && opts.rerankModel && ranked.length > 0) {
      try {
        const rerankRes = await this.deps.ebdRouter.rerank({
          providerId: opts.rerankProviderId,
          model:      opts.rerankModel,
          query,
          documents:  ranked.map(r => {
            const c = this.deps.store.getChunk(r.id);
            return c?.text ?? '';
          }),
          topK,
        });
        ranked = rerankRes.results
          .filter(r => r.index >= 0 && r.index < ranked.length && r.score >= MIN_RERANK_SCORE)
          .map(r => ({ id: ranked[r.index]!.id, score: r.score }));
      } catch {
        ranked = ranked.slice(0, topK);
      }
    } else {
      ranked = ranked.slice(0, topK);
    }

    // ── Build result hits with source attribution ─────────────────────────────
    // Parent-child (small-to-big): a matched child returns its parent window
    // (momText) for richer context, and sibling children of the same parent
    // collapse into one hit (keep the best-scored, which `ranked` lists first).
    const seenMom = new Set<string>();
    const hits: KbSearchResult['hits'] = [];
    for (const r of ranked) {
      const chunk = this.deps.store.getChunk(r.id);
      if (!chunk?.assetId) continue;
      if (chunk.momId) {
        if (seenMom.has(chunk.momId)) continue;
        seenMom.add(chunk.momId);
      }
      const asset = this.deps.store.getAsset(chunk.assetId);
      if (!asset) continue;
      const source: DocumentSourceRef = {
        assetId:      asset.id,
        fileName:     asset.fileName,
        page:         chunk.page,
        sectionPath:  chunk.sectionPath,
        chunkPreview: chunk.text.slice(0, 200),  // preview stays the matched child
      };
      hits.push({
        chunkId: chunk.id,
        text:    chunk.momText ?? chunk.text,    // return the parent window when present
        markdown: chunk.markdown,
        score:   r.score,
        source,
      });
    }

    return { query, hits };
  }

  // ── Asset accessors ───────────────────────────────────────────────────────

  getAsset(id: string): DocumentAsset | undefined              { return this.deps.store.getAsset(id); }
  getChunks(assetId: string): DocumentChunk[]                  { return this.deps.store.getChunks(assetId); }
  getChunksPaged(assetId: string, opts: { cursor?: number; limit?: number } = {}): ChunkPage {
    return this.deps.store.getChunksPaged(assetId, opts);
  }
  getAssetUsage(assetId: string): AssetUsage {
    return this.deps.store.getAssetUsage(assetId);
  }
  getPreview(assetId: string): DocumentPreview | undefined     { return this.deps.store.getPreview(assetId); }

  /** Cursor-paginated KB list for the UI (newest first), optional keyword. */
  listAssets(opts: { cursor?: string; limit?: number; keyword?: string } = {}): AssetListPage {
    return this.deps.store.listAssetsPaged(opts);
  }

  /** KBs not selected in the last `days` days (default 30). For the stale-KB view. */
  listInactiveAssets(days = 30): DocumentAsset[] {
    return this.deps.store.listInactiveAssets(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  deleteAsset(id: string): void {
    // Remove from HNSW before deleting from DB
    if (this.hnsw) {
      for (const [chunkId, assetId] of this.chunkToAsset) {
        if (assetId === id) {
          this.hnsw.remove(chunkId);
          this.chunkToAsset.delete(chunkId);
        }
      }
    }
    this.deps.store.deleteAsset(id);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bufferToFloat32(buf: Buffer): Float32Array {
  const f32 = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < f32.length; i++) f32[i] = buf.readFloatLE(i * 4);
  return f32;
}
