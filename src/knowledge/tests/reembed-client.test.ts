// 测试知识库重嵌入扫描结束后，SQLite 向量与内存索引保持一致。

import { describe, expect, it } from 'vitest';
import type { EmbedRuntime, EmbeddingSpace } from '@ema-agent/embed';
import { KnowledgeClient } from '../client.js';
import type { KnowledgeStore } from '../store/index.js';
import type { DocumentAsset, DocumentChunk } from '../types.js';

const SPACE: EmbeddingSpace = {
  id: 'space-1',
  providerId: 'provider-1',
  model: 'embed-1',
  dim: 2,
  normalization: 'l2',
  revision: 'test',
};

describe('重嵌入索引一致性', () => {
  it('同一轮成功写入的全部资产都进入最终内存索引', async () => {
    const store = new ReembedStore();
    const router = {
      embed: async (request: { texts: string[] }) => ({
        embeddings: request.texts.map(vectorForText),
        dim: SPACE.dim,
        space: SPACE,
      }),
    } as unknown as EmbedRuntime;
    const client = new KnowledgeClient({
      store: store as unknown as KnowledgeStore,
      embedRuntime: router,
    });
    const eventKinds: string[] = [];
    client.events.on(event => eventKinds.push(event.kind));

    const outcome = await client.reembedSweep({
      taskId: 'task-1',
      attempt: 1,
      ebdProviderId: SPACE.providerId,
      ebdModel: SPACE.model,
      signal: new AbortController().signal,
    });

    // 扫描完成时只应执行一次全量失效判定和一次索引替换。
    expect(store.markedSpaceIds).toEqual([SPACE.id]);
    const result = await client.search('query', {
      alpha: 1,
      topK: 10,
      ebdProviderId: SPACE.providerId,
      ebdModel: SPACE.model,
    });

    expect(outcome).toEqual({ total: 2, done: 2, failed: [] });
    expect(result.hits.map(hit => hit.chunkId).sort()).toEqual(['chunk-a', 'chunk-b']);
    expect(eventKinds).toEqual(['embed', 'embed']);
  });
});

function vectorForText(text: string): number[] {
  if (text === 'alpha') return [1, 0];
  if (text === 'beta') return [0, 1];
  return [1, 1];
}

function vectorBuffer(vector: number[]): Buffer {
  const values = Float32Array.from(vector);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

class ReembedStore {
  private readonly chunks = new Map<string, DocumentChunk>([
    ['chunk-a', makeChunk('chunk-a', 'asset-a', 'alpha')],
    ['chunk-b', makeChunk('chunk-b', 'asset-b', 'beta')],
  ]);
  private readonly assets = new Map<string, DocumentAsset>([
    ['asset-a', makeAsset('asset-a', 'a.txt')],
    ['asset-b', makeAsset('asset-b', 'b.txt')],
  ]);
  private readonly embeddings = new Map<string, { vector: number[]; spaceId: string }>();
  readonly markedSpaceIds: string[] = [];

  listStaleAssets(): DocumentAsset[] {
    return [...this.assets.values()];
  }

  getChunks(assetId: string): DocumentChunk[] {
    return [...this.chunks.values()].filter(chunk => chunk.assetId === assetId);
  }

  storeEmbedding(chunkId: string, vector: number[], spaceId: string): void {
    this.embeddings.set(chunkId, { vector, spaceId });
  }

  setEmbeddingSpace(assetId: string, space: EmbeddingSpace): void {
    const asset = this.assets.get(assetId);
    if (asset) {
      this.assets.set(assetId, { ...asset, ebdSpaceId: space.id, ebdStale: false });
    }
  }

  markStaleExcept(spaceId: string): void {
    this.markedSpaceIds.push(spaceId);
  }

  getAllEmbeddings(spaceId: string): Array<{ id: string; assetId: string; embedding: Buffer }> {
    return [...this.embeddings.entries()]
      .filter(([, value]) => value.spaceId === spaceId)
      .map(([id, value]) => ({
        id,
        assetId: this.chunks.get(id)!.assetId!,
        embedding: vectorBuffer(value.vector),
      }));
  }

  searchFts(): Array<{ chunkId: string; score: number }> {
    return [];
  }

  getChunk(id: string): DocumentChunk | undefined {
    return this.chunks.get(id);
  }

  getAsset(id: string): DocumentAsset | undefined {
    return this.assets.get(id);
  }
}

function makeChunk(id: string, assetId: string, text: string): DocumentChunk {
  return {
    id,
    assetId,
    text,
    blockKinds: ['paragraph'],
    tokenCount: 1,
    sectionPath: [],
  };
}

function makeAsset(id: string, fileName: string): DocumentAsset {
  return {
    id,
    filePath: fileName,
    fileName,
    mimeType: 'text/plain',
    wordCount: 1,
    status: 'indexed',
    createdAt: 1,
    updatedAt: 1,
    useCount: 0,
    ebdStale: true,
  };
}
