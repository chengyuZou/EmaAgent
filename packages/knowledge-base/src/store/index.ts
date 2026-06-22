import type {
  DocumentAsset, DocumentChunk, DocumentPreview,
  DocumentIndexStatus, AssetListPage,
} from '../types.js';
import type { DocumentAssetRepo }   from '@ema-agent/storage';
import type { DocumentChunkRepo }   from '@ema-agent/storage';
import type { DocumentPreviewRepo } from '@ema-agent/storage';
import type { ChunkSearchHit }      from '@ema-agent/storage';

export interface KbSearchOpts {
  /** Selected KB asset ids for this turn. undefined = all KBs; [] = none. */
  assetIds?: string[];
  topK:      number;
}

export class KnowledgeStore {
  constructor(
    private readonly assets:   DocumentAssetRepo,
    private readonly chunks:   DocumentChunkRepo,
    private readonly previews: DocumentPreviewRepo,
  ) {}

  // ── Asset ──────────────────────────────────────────────────────────────────

  addAsset(asset: DocumentAsset): void { this.assets.insert(asset); }

  getAsset(id: string): DocumentAsset | undefined {
    return this.assets.findById(id) as DocumentAsset | undefined;
  }

  /** All assets (unpaginated) — for HNSW priming / indexing, not the UI list. */
  listAllAssets(): DocumentAsset[] {
    return this.assets.listAll() as DocumentAsset[];
  }

  /** Cursor-paginated list for the UI (newest first), optional keyword filter. */
  listAssetsPaged(opts: { cursor?: number; limit?: number; keyword?: string } = {}): AssetListPage {
    return this.assets.listPaged(opts) as AssetListPage;
  }

  /** KBs not selected since `beforeTs` (last_activated_at, falling back to created_at). */
  listInactiveAssets(beforeTs: number): DocumentAsset[] {
    return this.assets.listInactiveSince(beforeTs) as DocumentAsset[];
  }

  /** Record a turn selecting these KBs: bump use_count + stamp last_activated_at. */
  recordActivation(assetIds: string[], ts: number = Date.now()): void {
    this.assets.recordActivation(assetIds, ts);
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

  getChunk(id: string): DocumentChunk | undefined {
    return this.chunks.findById(id) as DocumentChunk | undefined;
  }

  storeEmbedding(chunkId: string, vector: number[]): void {
    this.chunks.storeEmbedding(chunkId, vector);
  }

  /** BM25 full-text search via SQLite FTS5. */
  searchFts(query: string, opts: KbSearchOpts): ChunkSearchHit[] {
    return this.chunks.searchFts(query, opts.assetIds, opts.topK);
  }

  /** Cosine similarity search over persisted BLOB embeddings. */
  searchByEmbedding(queryVec: number[], opts: KbSearchOpts): ChunkSearchHit[] {
    return this.chunks.searchByEmbedding(queryVec, opts.assetIds, opts.topK);
  }

  // ── Preview ────────────────────────────────────────────────────────────────

  addPreview(preview: DocumentPreview): void { this.previews.upsert(preview); }

  getPreview(assetId: string): DocumentPreview | undefined {
    return this.previews.findByAsset(assetId) as DocumentPreview | undefined;
  }

  // ── Embedding model tracking ───────────────────────────────────────────────

  setEbdModel(assetId: string, model: string, dim: number): void {
    this.assets.setEbdModel(assetId, model, dim);
  }

  /** Mark all assets with a different ebd_model as stale. Returns count. */
  markStaleExcept(currentModel: string): number {
    return this.assets.markStaleExcept(currentModel);
  }

  listStaleAssets(): DocumentAsset[] {
    return this.assets.listEbdStale() as DocumentAsset[];
  }

  /** Load all non-stale embedded chunks for rebuilding the HNSW index. */
  getAllEmbeddings(): Array<{ id: string; assetId: string; embedding: Buffer }> {
    return this.chunks.getAllEmbeddings();
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  deleteAsset(id: string): void {
    this.assets.delete(id); // CASCADE deletes chunks + previews via FK
  }
}
