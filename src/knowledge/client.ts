// 负责单个知识库的文档写入、重嵌入、混合检索与内存向量索引。

import type { EmbeddingModel, EmbeddingSpace } from '@ema-agent/embed';
import { createEmbeddingSpace } from '@ema-agent/embed';
import type { Reranker } from '@ema-agent/rerank';
import type { VisionModel } from '@ema-agent/vision';
import type { AssetUsage, ChunkPage } from '@ema-agent/storage';
import type {
  AssetListPage,
  DocumentAsset,
  DocumentChunk,
  DocumentPreview,
  DocumentSourceRef,
  IngestOptions,
  IngestResult,
  KbSearchResult,
  SearchOptions,
} from './types.js';
import type { KnowledgeModelRef } from './settings.js';
import type { KnowledgeStore } from './store/store.js';
import type { VectorIndex } from './vector-index/vector-index.js';
import { createVectorIndex } from './vector-index/factory.js';
import { ingest as runIngest, type IngestStage } from './ingest/pipeline.js';
import { weightedRank } from './retrieval/hybrid.js';
import { applyResultBudget } from './retrieval/resultBudget.js';
import { removeStagedAssetFiles } from './ingest/staging.js';
import {
  KnowledgeDocumentProcessingError,
  KnowledgeEmbeddingSpaceMismatchError,
  KnowledgeInvalidRequestError,
  KnowledgeNotConfiguredError,
} from './errors.js';

const RERANK_BLEND_WEIGHT = 0.6;
const EMBED_BATCH_SIZE = 32;

export interface KnowledgeEmbeddingSelection {
  readonly providerConfigId: string;
  readonly model: string;
  readonly embedding: EmbeddingModel;
}

export interface KnowledgeRerankSelection {
  readonly model: string;
  readonly reranker: Reranker;
}

export interface KnowledgeVisionSelection {
  readonly model: string;
  readonly vision: VisionModel;
}

export interface KnowledgeClientDeps {
  readonly store: KnowledgeStore;
  readonly resolveEmbedding: () => KnowledgeEmbeddingSelection | undefined;
  readonly resolveEmbeddingByRef: (ref: KnowledgeModelRef) => EmbeddingModel | undefined;
  readonly resolveReranker: () => KnowledgeRerankSelection | undefined;
  readonly resolveVision: () => KnowledgeVisionSelection | undefined;
  readonly kbRoot?: string;
}

export class KnowledgeClient {
  private vectorIndex: VectorIndex | null = null;
  private vectorIndexSpaceId: string | null = null;
  private readonly chunkToAsset = new Map<string, string>();

  constructor(private readonly deps: KnowledgeClientDeps) {}

  async ingest(
    filePath: string,
    options: IngestOptions,
    onProgress?: (assetId: string, stage: IngestStage, progress: number) => void,
  ): Promise<IngestResult> {
    const result = await runIngest(filePath, options, {
      store: this.deps.store,
      embedding: this.deps.resolveEmbedding(),
      vision: this.deps.resolveVision(),
      onProgress,
    });
    // 内容重复时返回的是既有资产：本任务预生成的 assetId 及其 staged 副本都要清掉。
    if (
      this.deps.kbRoot
      && options.assetId !== undefined
      && result.asset.id !== options.assetId
    ) {
      await removeStagedAssetFiles(this.deps.kbRoot, options.assetId).catch(() => {});
    }
    const stored = this.deps.store.getAsset(result.asset.id);
    if (stored?.embeddingSpaceId && stored.embeddingDim) {
      await this.addAssetToIndex(stored.id, stored.embeddingSpaceId, stored.embeddingDim);
    }
    return result;
  }

  invalidateEmbeddings(newSpaceId: string): number {
    const count = this.deps.store.markStaleExcept(newSpaceId);
    this.clearIndex();
    return count;
  }

  /** 全量重建 fan-out 前的预检：一次短文本 embed 验证 key/模型/维度，失败则一行任务都不建。 */
  async probeEmbeddingSpace(ref: KnowledgeModelRef, signal?: AbortSignal): Promise<EmbeddingSpace> {
    const model = this.deps.resolveEmbeddingByRef(ref);
    if (!model) {
      throw new KnowledgeNotConfiguredError(
        `Embedding 配置已删除或模型未启用: ${ref.providerConfigId} / ${ref.model}`,
      );
    }
    const response = await model.embed({ model: ref.model, texts: ['空间预检'], ...(signal === undefined ? {} : { signal }) });
    return createEmbeddingSpace({
      providerConfigId: ref.providerConfigId,
      model: ref.model,
      dim: response.dim,
    });
  }

  listStaleAssetIds(): string[] {
    return this.deps.store.listStaleAssets().map((asset) => asset.id);
  }

  /** 重建单个资产的向量并冻结新空间；内存索引空间一致时增量挂载，否则留给检索侧惰性重建。 */
  async reembedAsset(
    assetId: string,
    selection: KnowledgeModelRef,
    signal: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<EmbeddingSpace> {
    const embedding = this.deps.resolveEmbeddingByRef(selection);
    if (!embedding) {
      throw new KnowledgeNotConfiguredError(
        `Embedding 配置已删除或模型未启用: ${selection.providerConfigId} / ${selection.model}`,
      );
    }
    const chunks = this.deps.store.getChunks(assetId);
    let space: EmbeddingSpace | undefined;
    for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
      const response = await embedding.embed({
        model: selection.model,
        texts: batch.map((chunk) => chunk.text),
        signal,
      });
      const responseSpace = createEmbeddingSpace({
        providerConfigId: selection.providerConfigId,
        model: selection.model,
        dim: response.dim,
      });
      // 同一资产内跨批次的维度漂移才算空间不符；跨资产一致性由"同批任务同一模型"保证。
      if (space && space.id !== responseSpace.id) {
        throw new KnowledgeEmbeddingSpaceMismatchError(space.id, responseSpace.id);
      }
      space = responseSpace;
      this.deps.store.storeEmbeddings(
        batch.map((chunk, index) => ({ id: chunk.id, vector: [...response.embeddings[index]!] })),
        responseSpace.id,
      );
      onProgress?.(Math.min(offset + batch.length, chunks.length), chunks.length);
    }
    if (!space) {
      // 调用方只在有 chunk 时进来；防御的是"embed 全程无响应"这条不可达路径。
      throw new KnowledgeDocumentProcessingError(`Knowledge asset has no chunks: ${assetId}`);
    }
    this.deps.store.setEmbeddingSpace(assetId, space);
    if (this.vectorIndex && this.vectorIndexSpaceId === space.id) {
      await this.addAssetToIndex(assetId, space.id, space.dim);
    }
    return space;
  }

  async search(query: string, options: SearchOptions = {}): Promise<KbSearchResult> {
    validateSearch(query, options);
    if (options.assetIds?.length === 0) return { query, hits: [] };

    const assetIds = options.assetIds
      ? this.deps.store.filterExistingAssetIds(options.assetIds)
      : undefined;
    if (options.assetIds && assetIds?.length === 0) return { query, hits: [] };

    const topK = options.topK ?? 10;
    const alpha = options.alpha ?? 0.5;
    const searchOptions = { assetIds, topK: topK * 3 };
    const selected = assetIds ? new Set(assetIds) : undefined;
    const sparse = this.deps.store.searchFts(query, searchOptions)
      .map((hit) => ({ id: hit.chunkId, score: hit.score }));
    const dense = await this.searchDense(query, topK, searchOptions, selected, options.signal);
    let ranked = weightedRank(sparse, dense, alpha, topK * 2);

    const rerank = this.deps.resolveReranker();
    if (rerank && ranked.length > 0) {
      try {
        const response = await rerank.reranker.rerank({
          model: rerank.model,
          query,
          documents: ranked.map((item) => this.deps.store.getChunk(item.id)?.text ?? ''),
          topK,
          signal: options.signal,
        });
        ranked = blendRerank(ranked, response.results, options.rerankBlendWeight ?? RERANK_BLEND_WEIGHT, topK);
      } catch (error) {
        // 取消不是 rerank 故障，必须向上传播，不能伪装成降级结果。
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        ranked = ranked.slice(0, topK);
      }
    } else {
      ranked = ranked.slice(0, topK);
    }

    return {
      query,
      hits: applyResultBudget(this.buildHits(ranked), options.maxResultChars),
    };
  }

  getAsset(id: string): DocumentAsset | undefined {
    return this.deps.store.getAsset(id);
  }

  getChunks(assetId: string): DocumentChunk[] {
    return this.deps.store.getChunks(assetId);
  }

  getChunksPaged(assetId: string, options: { cursor?: number; limit?: number } = {}): ChunkPage {
    return this.deps.store.getChunksPaged(assetId, options);
  }

  getAssetUsage(assetId: string): AssetUsage {
    return this.deps.store.getAssetUsage(assetId);
  }

  getPreview(assetId: string): DocumentPreview | undefined {
    return this.deps.store.getPreview(assetId);
  }

  listAssets(options: { cursor?: string; limit?: number; keyword?: string } = {}): AssetListPage {
    return this.deps.store.listAssetsPaged(options);
  }

  listInactiveAssets(days = 30): DocumentAsset[] {
    return this.deps.store.listInactiveAssets(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  async deleteAsset(id: string): Promise<void> {
    if (this.vectorIndex) {
      for (const [chunkId, assetId] of this.chunkToAsset) {
        if (assetId !== id) continue;
        this.vectorIndex.remove(chunkId);
        this.chunkToAsset.delete(chunkId);
      }
    }
    this.deps.store.deleteAsset(id);
    if (!this.deps.kbRoot) return;
    try {
      await removeStagedAssetFiles(this.deps.kbRoot, id);
    } catch (error) {
      console.warn(`[kb] staged 文件清理失败（文档已删除）: ${errorMessage(error)}`);
    }
  }

  private async searchDense(
    query: string,
    topK: number,
    searchOptions: { assetIds?: string[]; topK: number },
    selected: ReadonlySet<string> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Array<{ id: string; score: number }>> {
    const embedding = this.deps.resolveEmbedding();
    if (!embedding) return [];
    try {
      const response = await embedding.embedding.embed({ model: embedding.model, texts: [query], signal });
      const vector = response.embeddings[0];
      if (!vector) return [];
      const space = createEmbeddingSpace({
        providerConfigId: embedding.providerConfigId,
        model: embedding.model,
        dim: response.dim,
      });
      await this.ensureIndex(space);
      if (!this.vectorIndex) {
        return this.deps.store.searchByEmbedding([...vector], space.id, searchOptions)
          .map((hit) => ({ id: hit.chunkId, score: hit.score }));
      }
      return this.vectorIndex.search(new Float32Array(vector), topK * 6)
        .filter((hit) => {
          const assetId = this.chunkToAsset.get(hit.id);
          return assetId !== undefined && (!selected || selected.has(assetId));
        })
        .slice(0, topK * 3)
        .map((hit) => ({ id: hit.id, score: hit.score }));
    } catch (error) {
      // 取消不是嵌入故障，向上传播；其余失败才降级为仅 BM25。
      if (signal?.aborted) throw signal.reason ?? error;
      return [];
    }
  }

  private buildHits(ranked: readonly { id: string; score: number }[]): KbSearchResult['hits'] {
    const seenParents = new Set<string>();
    const hits: KbSearchResult['hits'] = [];
    for (const item of ranked) {
      const chunk = this.deps.store.getChunk(item.id);
      if (!chunk?.assetId) continue;
      if (chunk.parentId) {
        if (seenParents.has(chunk.parentId)) continue;
        seenParents.add(chunk.parentId);
      }
      const asset = this.deps.store.getAsset(chunk.assetId);
      if (!asset) continue;
      const source: DocumentSourceRef = {
        assetId: asset.id,
        fileName: asset.fileName,
        page: chunk.page,
        sectionPath: chunk.sectionPath,
        chunkPreview: chunk.text.slice(0, 200),
      };
      hits.push({
        chunkId: chunk.id,
        text: chunk.parentText ?? chunk.text,
        markdown: chunk.markdown,
        score: item.score,
        source,
      });
    }
    return hits;
  }

  private async ensureIndex(space: EmbeddingSpace): Promise<void> {
    if (this.vectorIndexSpaceId !== space.id || this.vectorIndex?.dim !== space.dim) {
      await this.rebuildIndex(space.id, space.dim);
    }
  }

  /** 索引空间一致时把新资产增量挂进内存索引；不一致才全量重建。 */
  private async addAssetToIndex(assetId: string, spaceId: string, dim: number): Promise<void> {
    if (!this.vectorIndex || this.vectorIndexSpaceId !== spaceId || this.vectorIndex.dim !== dim) {
      await this.rebuildIndex(spaceId, dim);
      return;
    }
    for (const row of this.deps.store.getEmbeddingsForAsset(assetId, spaceId)) {
      this.vectorIndex.add(row.id, bufferToFloat32(row.embedding));
      this.chunkToAsset.set(row.id, assetId);
    }
  }

  private async rebuildIndex(spaceId: string, dim: number): Promise<void> {
    const next = await createVectorIndex(dim);
    const mapping = new Map<string, string>();
    for (const row of this.deps.store.getAllEmbeddings(spaceId)) {
      next.add(row.id, bufferToFloat32(row.embedding));
      mapping.set(row.id, row.assetId);
    }
    this.vectorIndex = next;
    this.vectorIndexSpaceId = spaceId;
    this.chunkToAsset.clear();
    for (const [chunkId, assetId] of mapping) this.chunkToAsset.set(chunkId, assetId);
  }

  private clearIndex(): void {
    this.vectorIndex = null;
    this.vectorIndexSpaceId = null;
    this.chunkToAsset.clear();
  }
}

function validateSearch(query: string, options: SearchOptions): void {
  if (!query.trim()) throw new KnowledgeInvalidRequestError('Knowledge query must not be empty');
  if (options.topK !== undefined && (!Number.isSafeInteger(options.topK) || options.topK < 1 || options.topK > 20)) {
    throw new KnowledgeInvalidRequestError('Knowledge topK must be an integer between 1 and 20');
  }
  for (const value of [options.alpha, options.rerankBlendWeight]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new KnowledgeInvalidRequestError('Knowledge ranking weights must be between 0 and 1');
    }
  }
}

function blendRerank(
  ranked: readonly { id: string; score: number }[],
  reranked: readonly { index: number; score: number }[],
  weight: number,
  topK: number,
): Array<{ id: string; score: number }> {
  const maxRank = ranked[0]?.score ?? 0;
  const byId = new Map(
    reranked
      .filter((item) => item.index >= 0 && item.index < ranked.length)
      .map((item) => [ranked[item.index]!.id, item.score] as const),
  );
  return ranked
    .map((item) => ({
      id: item.id,
      score: (1 - weight) * (maxRank > 0 ? item.score / maxRank : 0)
        + weight * (byId.get(item.id) ?? 0),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

function bufferToFloat32(buffer: Buffer): Float32Array {
  const values = new Float32Array(buffer.byteLength / 4);
  for (let index = 0; index < values.length; index++) {
    values[index] = buffer.readFloatLE(index * 4);
  }
  return values;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
