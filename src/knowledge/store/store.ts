import type {
  DocumentAsset, DocumentChunk, DocumentPreview,
  DocumentIndexStatus, AssetListPage,
} from '../types.js';
import type { DocumentAssetRepo }   from '@ema-agent/storage';
import type { DocumentChunkRepo }   from '@ema-agent/storage';
import type { DocumentPreviewRepo } from '@ema-agent/storage';
import type { KbActivationsRepo }   from '@ema-agent/storage';
import type { ChunkSearchHit }      from '@ema-agent/storage';
import type { ChunkPage }           from '@ema-agent/storage';
import type { AssetUsage }          from '@ema-agent/storage';
import type { EmbeddingSpace }      from '@ema-agent/embed';

export interface KbSearchOpts {
  /** Document filter within this KB. undefined = search all docs; [] = unfiltered (same as undefined). */
  assetIds?: string[];
  topK?:     number;
}

export class KnowledgeStore {
  constructor(
    private readonly assets:      DocumentAssetRepo,
    private readonly chunks:      DocumentChunkRepo,
    private readonly previews:    DocumentPreviewRepo,
    private readonly activations: KbActivationsRepo,
    private readonly kbId:        string,
  ) {}

  // ── Asset ──────────────────────────────────────────────────────────────────

  addAsset(asset: DocumentAsset): void { this.assets.insert(asset); }

  getAsset(id: string): DocumentAsset | undefined {
    return this.assets.findById(id) as DocumentAsset | undefined;
  }

  listAssetsPaged(opts: { cursor?: string; limit?: number; keyword?: string } = {}): AssetListPage {
    return this.assets.listPaged(opts) as AssetListPage;
  }

  /** KBs not selected since `beforeTs` (last_activated_at, falling back to created_at). */
  listInactiveAssets(beforeTs: number): DocumentAsset[] {
    return this.assets.listInactiveSince(beforeTs) as DocumentAsset[];
  }

  /** 把外部 asset scope 收窄到当前 KB 数据库真实拥有的文档。 */
  filterExistingAssetIds(assetIds: readonly string[]): string[] {
    return [...new Set(this.assets.findExistingIds(assetIds))];
  }

  /** Record a turn selecting these KBs: bump use_count + stamp last_activated_at,
   *  and log one kb_activations call (per-asset rows) when a session is known. */
  recordActivation(
    assetIds: string[],
    opts: { sessionId?: string; turnId?: string; ts?: number } = {},
  ): string[] {
    const ownedAssetIds = this.filterExistingAssetIds(assetIds);
    if (ownedAssetIds.length === 0) return ownedAssetIds;
    const ts = opts.ts ?? Date.now();
    this.assets.recordActivation(ownedAssetIds, ts);
    if (opts.sessionId) {
      this.activations.recordCall({
        kbId: this.kbId,
        assetIds: ownedAssetIds,
        sessionId: opts.sessionId,
        turnId: opts.turnId,
        ts,
      });
    }
    return ownedAssetIds;
  }

  findAssetByHash(hash: string): DocumentAsset | undefined {
    return this.assets.findByHash(hash) as DocumentAsset | undefined;
  }

  updateStatus(id: string, status: DocumentIndexStatus): void {
    this.assets.updateStatus(id, status);
  }

  patchAssetMeta(id: string, meta: { title?: string; wordCount?: number; pageCount?: number }): void {
    this.assets.patchMeta(id, meta);
  }

  // ── Chunks ─────────────────────────────────────────────────────────────────

  addChunks(chunks: DocumentChunk[]): void {
    this.chunks.insertMany(chunks as Required<DocumentChunk>[]);
  }

  getChunks(assetId: string): DocumentChunk[] {
    return this.chunks.findByAsset(assetId) as DocumentChunk[];
  }

  /** Cursor-paginated chunk summaries for the document detail viewer. */
  getChunksPaged(assetId: string, opts: { cursor?: number; limit?: number } = {}): ChunkPage {
    return this.chunks.findByAssetPaged(assetId, opts);
  }

  /** Per-session usage breakdown for one KB document (which sessions, how many calls). */
  getAssetUsage(assetId: string): AssetUsage {
    return this.activations.usageForAsset(assetId);
  }

  getChunk(id: string): DocumentChunk | undefined {
    return this.chunks.findById(id) as DocumentChunk | undefined;
  }

  storeEmbeddings(entries: Array<{ id: string; vector: number[] }>, spaceId: string): void {
    this.chunks.storeEmbeddings(entries, spaceId);
  }

  /** BM25 full-text search via SQLite FTS5. */
  searchFts(query: string, opts: KbSearchOpts): ChunkSearchHit[] {
    return this.chunks.searchFts(query, opts.assetIds, opts.topK ?? 10);
  }

  /** Cosine similarity search over persisted BLOB embeddings. */
  searchByEmbedding(queryVec: number[], spaceId: string, opts: KbSearchOpts): ChunkSearchHit[] {
    return this.chunks.searchByEmbedding(queryVec, spaceId, opts.assetIds, opts.topK ?? 10);
  }

  // ── Preview ────────────────────────────────────────────────────────────────

  addPreview(preview: DocumentPreview): void { this.previews.upsert(preview); }

  getPreview(assetId: string): DocumentPreview | undefined {
    return this.previews.findByAsset(assetId) as DocumentPreview | undefined;
  }

  // ── Embedding model tracking ───────────────────────────────────────────────

  setEmbeddingSpace(assetId: string, space: EmbeddingSpace): void {
    this.assets.setEmbeddingSpace(assetId, space);
  }

  /** 把空间 id 不等于 currentSpaceId 的就绪资产标 stale（切回原空间会清回）。 */
  markStaleExcept(currentSpaceId: string): number {
    return this.assets.markStaleExcept(currentSpaceId);
  }

  listStaleAssets(): DocumentAsset[] {
    return this.assets.listEmbeddingStale() as DocumentAsset[];
  }

  /** Load all non-stale embedded chunks for rebuilding the HNSW index. */
  getAllEmbeddings(spaceId: string): Array<{ id: string; assetId: string; embedding: Buffer }> {
    return this.chunks.getAllEmbeddings(spaceId);
  }

  /** 摄入成功后按 asset 增量加载 embedding，避免整库重建内存索引。 */
  getEmbeddingsForAsset(assetId: string, spaceId: string): Array<{ id: string; embedding: Buffer }> {
    return this.chunks.getEmbeddingsForAsset(assetId, spaceId);
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  deleteAsset(id: string): void {
    this.assets.delete(id); // CASCADE deletes chunks + previews via FK
  }
}
