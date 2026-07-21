import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EmbedRuntime, EmbeddingSpace } from '@ema-agent/embed';
import { DocumentEventEmitter } from '../events/emitter.js';
import { ingest } from '../ingest/index.js';
import type { KnowledgeStore } from '../store/index.js';
import type {
  DocumentAsset,
  DocumentChunk,
  DocumentPreview,
} from '../types.js';

describe('B-012 embedding 局部失败', () => {
  it('Provider 返回的向量数量不一致时记录失败分片，不把任务伪装成完整成功', async () => {
    const store = new InMemoryIngestStore();
    const events = new DocumentEventEmitter();
    const seenKinds: string[] = [];
    events.on(event => seenKinds.push(event.kind));
    const space: EmbeddingSpace = {
      id: 'space-1',
      providerId: 'provider-1',
      model: 'embed-1',
      dim: 2,
      normalization: 'l2',
      revision: 'test',
    };
    const router = {
      embed: async () => ({ embeddings: [], dim: 2, space }),
    } as unknown as EmbedRuntime;

    const result = await ingest(
      fileURLToPath(new URL('./fixtures/embedding-mismatch.txt', import.meta.url)),
      {
        assetId: 'asset-mismatch',
        taskId: 'task-mismatch',
        attempt: 1,
        ebdProviderId: 'provider-1',
        ebdModel: 'embed-1',
      },
      { store: store as unknown as KnowledgeStore, events, embedRuntime: router },
    );

    expect(result.outcome).toBe('partial_failed');
    expect(result.counts).toEqual({ total: 1, completed: 0, failed: 1 });
    expect(result.failureShards).toMatchObject([{
      stage: 'embed',
      shardKey: 'embed:0',
      retryable: true,
      errorCode: 'kb/embed-batch-failed',
    }]);
    expect(result.failureShards[0]!.error).toContain('Embedding count mismatch');
    expect(store.embeddings).toHaveLength(0);
    expect(store.asset?.status).toBe('indexed');
    expect(seenKinds.at(-1)).toBe('partial_failed');
  });
});

class InMemoryIngestStore {
  asset?: DocumentAsset;
  chunks: DocumentChunk[] = [];
  preview?: DocumentPreview;
  embeddings: Array<{ chunkId: string; vector: number[]; spaceId: string }> = [];

  getAsset(id: string): DocumentAsset | undefined {
    return this.asset?.id === id ? this.asset : undefined;
  }

  findAssetByHash(): DocumentAsset | undefined {
    return undefined;
  }

  addAsset(asset: DocumentAsset): void {
    this.asset = asset;
  }

  deleteAsset(): void {
    this.asset = undefined;
    this.chunks = [];
    this.preview = undefined;
    this.embeddings = [];
  }

  patchAssetMeta(_id: string, meta: Partial<DocumentAsset>): void {
    if (this.asset) this.asset = { ...this.asset, ...meta };
  }

  updateStatus(_id: string, status: DocumentAsset['status']): void {
    if (this.asset) this.asset = { ...this.asset, status };
  }

  addChunks(chunks: DocumentChunk[]): void {
    this.chunks.push(...chunks);
  }

  storeEmbedding(chunkId: string, vector: number[], spaceId: string): void {
    this.embeddings.push({ chunkId, vector, spaceId });
  }

  setEmbeddingSpace(): void {}

  addPreview(preview: DocumentPreview): void {
    this.preview = preview;
  }
}
