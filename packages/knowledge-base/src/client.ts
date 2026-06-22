import type {
  DocumentAsset, DocumentChunk, DocumentPreview,
  IngestOptions, IngestResult, SearchOptions,
} from './types.js';
import type { KbSearchResult, DocumentSourceRef } from '@ema-agent/contracts';
import type { EbdRouter } from '@ema-agent/ebd-client';
import { ingest as runIngest } from './ingest/index.js';
import type { KnowledgeStore } from './store/index.js';
import type { KbVisionAdapter } from './adapters/vision.js';
import type { KbHydeAdapter }   from './adapters/hyde.js';
import type { KbAutoQuestionAdapter } from './adapters/auto-questions.js';
import { DocumentEventEmitter } from './events/emitter.js';
import { weightedRank }         from './retrieval/hybrid.js';
import type { VectorIndex }     from './index/vector-index.js';
import { createVectorIndex }    from './index/factory.js';

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

export interface ReembedOptions {
  ebdProviderId: string;
  ebdModel:      string;
  signal?:       AbortSignal;
  onProgress?:   (done: number, total: number) => void;
}

export class KnowledgeClient {
  readonly events = new DocumentEventEmitter();

  // In-memory HNSW (or brute-force fallback). null until init() is called.
  private hnsw: VectorIndex | null = null;
  // chunkId → assetId for O(1) scope lookup after HNSW search
  private readonly chunkToAsset = new Map<string, string>();
  // assetId → { scope, sessionId } — avoids extra DB round-trips during search
  private readonly assetMeta = new Map<string, { scope: string; sessionId?: string }>();

  constructor(private readonly deps: KnowledgeClientDeps) {}

  /**
   * Build the in-memory HNSW index from persisted BLOB embeddings.
   * Must be called once after construction (or after a reembed completes).
   * Safe to call again — clears and rebuilds the index.
   */
  async init(): Promise<void> {
    const rows = this.deps.store.getAllEmbeddings();
    if (rows.length === 0) return;

    const dim = rows[0]!.embedding.byteLength / 4;
    this.hnsw = await createVectorIndex(dim);
    this.chunkToAsset.clear();
    this.assetMeta.clear();

    for (const { id, assetId, embedding } of rows) {
      const vec = bufferToFloat32(embedding);
      this.hnsw.add(id, vec);
      this.chunkToAsset.set(id, assetId);
    }

    // Populate assetMeta from store for all assets referenced by these chunks
    for (const assetId of new Set(this.chunkToAsset.values())) {
      const asset = this.deps.store.getAsset(assetId);
      if (asset) this.assetMeta.set(assetId, { scope: asset.scope, sessionId: asset.sessionId });
    }
  }

  // ── Ingest ────────────────────────────────────────────────────────────────

  async ingest(filePath: string, opts: IngestOptions): Promise<IngestResult> {
    const result = await runIngest(filePath, opts, {
      store:         this.deps.store,
      events:        this.events,
      ebdRouter:     this.deps.ebdRouter,
      visionAdapter: this.deps.visionAdapter,
    });

    // After ingest, update ebd model tracking + add new embeddings to HNSW
    if (opts.ebdModel) {
      const chunks = this.deps.store.getChunks(result.asset.id);
      let dim = 0;
      for (const chunk of chunks) {
        // Determine dim from first chunk that has an embedding row (if any)
        if (!dim) {
          const raw = this.deps.store.getAllEmbeddings()
            .find(r => r.id === chunk.id);
          if (raw) dim = raw.embedding.byteLength / 4;
        }
      }
      if (dim) {
        this.deps.store.setEbdModel(result.asset.id, opts.ebdModel, dim);
        await this._addAssetToHnsw(result.asset.id, opts.ebdModel, dim);
      }
    }

    return result;
  }

  private async _addAssetToHnsw(assetId: string, model: string, dim: number): Promise<void> {
    if (!this.hnsw) {
      this.hnsw = await createVectorIndex(dim);
    }
    const rows = this.deps.store.getAllEmbeddings().filter(r => r.assetId === assetId);
    const asset = this.deps.store.getAsset(assetId);
    if (asset) this.assetMeta.set(assetId, { scope: asset.scope, sessionId: asset.sessionId });
    for (const { id, embedding } of rows) {
      const vec = bufferToFloat32(embedding);
      this.hnsw.add(id, vec);
      this.chunkToAsset.set(id, assetId);
    }
    void model; // dim is used above; model is stored in DB by the caller
  }

  // ── Embedding model invalidation ──────────────────────────────────────────

  /**
   * Call this when the user switches embedding providers/models.
   * Marks all assets with a different model as stale in the DB and removes
   * their chunk vectors from the in-memory HNSW index.
   * Returns the number of assets marked stale.
   */
  invalidateEmbeddings(newModel: string): number {
    const count = this.deps.store.markStaleExcept(newModel);
    if (count > 0 && this.hnsw) {
      // Remove stale chunk vectors from the index. We identify them by checking
      // which assetIds no longer appear in the fresh embedding list.
      const freshIds = new Set(this.deps.store.getAllEmbeddings().map(r => r.id));
      for (const [chunkId, assetId] of this.chunkToAsset) {
        if (!freshIds.has(chunkId)) {
          this.hnsw.remove(chunkId);
          this.chunkToAsset.delete(chunkId);
          // Clean up assetMeta if no more chunks reference this asset
          const stillHas = [...this.chunkToAsset.values()].some(aid => aid === assetId);
          if (!stillHas) this.assetMeta.delete(assetId);
        }
      }
    }
    return count;
  }

  /**
   * Re-embed all stale assets in the background. Updates HNSW on completion.
   * Call this after `invalidateEmbeddings()` to restore dense-retrieval quality.
   */
  async reembed(opts: ReembedOptions): Promise<{ done: number; failed: number }> {
    if (!this.deps.ebdRouter) return { done: 0, failed: 0 };

    const stale  = this.deps.store.listStaleAssets();
    let done = 0, failed = 0;

    for (const asset of stale) {
      if (opts.signal?.aborted) break;
      try {
        const chunks = this.deps.store.getChunks(asset.id);
        if (chunks.length === 0) { done++; continue; }

        const BATCH = 32;
        let dim = 0;
        for (let i = 0; i < chunks.length; i += BATCH) {
          const batch = chunks.slice(i, i + BATCH);
          const res = await this.deps.ebdRouter.embed({
            providerId: opts.ebdProviderId,
            model:      opts.ebdModel,
            texts:      batch.map(c => c.text),
            signal:     opts.signal,
          });
          for (let j = 0; j < batch.length; j++) {
            const vec = res.embeddings[j];
            if (vec?.length) {
              this.deps.store.storeEmbedding(batch[j]!.id, vec);
              if (!dim) dim = vec.length;
            }
          }
        }

        this.deps.store.setEbdModel(asset.id, opts.ebdModel, dim);
        if (dim) await this._addAssetToHnsw(asset.id, opts.ebdModel, dim);
        done++;
        opts.onProgress?.(done, stale.length);
      } catch {
        failed++;
      }
    }

    return { done, failed };
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async search(query: string, opts: SearchOptions = { scope: 'global' }): Promise<KbSearchResult> {
    const topK  = opts.topK  ?? 10;
    const alpha = opts.alpha ?? 0.5;

    const searchOpts = { scope: opts.scope, sessionId: opts.sessionId, topK: topK * 3 };

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
          if (this.hnsw) {
            // HNSW path: search with extra budget, then filter by scope
            const f32 = new Float32Array(queryVec);
            const raw = this.hnsw.search(f32, topK * 6);
            denseHits = raw
              .filter(h => {
                const assetId = this.chunkToAsset.get(h.id);
                if (!assetId) return false;
                const meta = this.assetMeta.get(assetId);
                if (!meta) return false;
                if (meta.scope !== opts.scope) return false;
                if (opts.scope === 'session' && opts.sessionId && meta.sessionId !== opts.sessionId) return false;
                return true;
              })
              .slice(0, topK * 3)
              .map(h => ({ id: h.id, score: h.score }));
          } else {
            // Fallback: O(n) SQL cosine scan
            denseHits = toRanked(this.deps.store.searchByEmbedding(queryVec, searchOpts));
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
  getPreview(assetId: string): DocumentPreview | undefined     { return this.deps.store.getPreview(assetId); }

  listAssets(scope: 'global' | 'session', sessionId?: string): DocumentAsset[] {
    return this.deps.store.listAssets(scope, sessionId);
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
    this.assetMeta.delete(id);
    this.deps.store.deleteAsset(id);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bufferToFloat32(buf: Buffer): Float32Array {
  const f32 = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < f32.length; i++) f32[i] = buf.readFloatLE(i * 4);
  return f32;
}
