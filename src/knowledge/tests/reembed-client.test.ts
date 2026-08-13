// 测试重嵌入：probe 冻结空间后有界并发，单资产失败不拖死全场，终末统一失效判定 + 索引重建。

import { describe, expect, it } from 'vitest';
import type { EmbeddingModel } from '@ema-agent/embed';
import { KnowledgeClient } from '../client.js';
import type { KnowledgeClientDeps } from '../client.js';
import type { KnowledgeStore } from '../store/store.js';
import type { DocumentAsset, DocumentChunk } from '../types.js';

function makeChunk(id: string, assetId: string, text: string): DocumentChunk {
  return { id, assetId, text, blockKinds: ['paragraph'], tokenCount: 1, sectionPath: [] };
}

function makeAsset(id: string, fileName: string): DocumentAsset {
  return {
    id, filePath: fileName, fileName, mimeType: 'text/plain', wordCount: 1,
    status: 'ready', createdAt: 1, updatedAt: 1, useCount: 0, embeddingStale: true,
  };
}

class ReembedStore {
  readonly chunks = new Map<string, DocumentChunk>();
  readonly assets = new Map<string, DocumentAsset>();
  readonly embedded = new Map<string, { vector: number[]; spaceId: string }>();
  readonly markedSpaceIds: string[] = [];

  add(assetId: string, fileName: string, chunkIds: string[]): void {
    this.assets.set(assetId, makeAsset(assetId, fileName));
    for (const id of chunkIds) this.chunks.set(id, makeChunk(id, assetId, `text-of-${id}`));
  }

  listStaleAssets(): DocumentAsset[] { return [...this.assets.values()]; }
  getChunks(assetId: string): DocumentChunk[] {
    return [...this.chunks.values()].filter((chunk) => chunk.assetId === assetId);
  }
  storeEmbeddings(entries: Array<{ id: string; vector: number[] }>, spaceId: string): void {
    for (const entry of entries) this.embedded.set(entry.id, { vector: entry.vector, spaceId });
  }
  setEmbeddingSpace(assetId: string, space: { id: string }): void {
    const asset = this.assets.get(assetId);
    if (asset) this.assets.set(assetId, { ...asset, embeddingSpaceId: space.id, embeddingStale: false });
  }
  markStaleExcept(spaceId: string): number {
    this.markedSpaceIds.push(spaceId);
    return 0;
  }
  getAllEmbeddings(spaceId: string): Array<{ id: string; assetId: string; embedding: Buffer }> {
    return [...this.embedded.entries()]
      .filter(([, value]) => value.spaceId === spaceId)
      .map(([id, value]) => ({
        id,
        assetId: this.chunks.get(id)!.assetId!,
        embedding: Buffer.from(Float32Array.from(value.vector).buffer),
      }));
  }
}

function makeDeps(
  store: ReembedStore,
  embed: EmbeddingModel['embed'],
): KnowledgeClientDeps {
  return {
    store: store as unknown as KnowledgeStore,
    resolveEmbedding: () => undefined,
    resolveEmbeddingByRef: () => ({ embed }) as unknown as EmbeddingModel,
    resolveReranker: () => undefined,
    resolveVision: () => undefined,
  };
}

const REF = { providerConfigId: 'provider-1', model: 'embed-1' };

describe('重嵌入并发与失败容忍', () => {
  it('多资产有界并发，收尾只做一次失效判定', async () => {
    const store = new ReembedStore();
    for (let i = 0; i < 5; i++) store.add(`asset-${i}`, `${i}.txt`, [`asset-${i}-c0`]);
    let inFlight = 0;
    let peak = 0;
    const client = new KnowledgeClient(makeDeps(store, async ({ texts }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return { embeddings: texts.map(() => [1, 0]), dim: 2 };
    }));

    const result = await client.reembed({
      embedding: REF,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ total: 5, completed: 5, failedAssetIds: [] });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(store.markedSpaceIds).toHaveLength(1);
    expect([...store.assets.values()].every((a) => a.embeddingStale === false)).toBe(true);
  });

  it('单资产失败记录 failedAssetIds，其余照常完成', async () => {
    const store = new ReembedStore();
    store.add('asset-ok', 'ok.txt', ['asset-ok-c0']);
    store.add('asset-bad', 'bad.txt', ['asset-bad-c0']);
    const client = new KnowledgeClient(makeDeps(store, async ({ texts }) => {
      if (texts[0]!.includes('bad')) throw new Error('provider 500');
      return { embeddings: texts.map(() => [1, 0]), dim: 2 };
    }));

    const result = await client.reembed({
      embedding: REF,
      signal: new AbortController().signal,
    });

    expect(result.completed).toBe(1);
    expect(result.failedAssetIds).toEqual(['asset-bad']);
    expect(store.assets.get('asset-bad')!.embeddingStale).toBe(true);
    expect(store.markedSpaceIds).toHaveLength(1);
  });

  it('abort 中断整场并向上抛', async () => {
    const store = new ReembedStore();
    store.add('asset-a', 'a.txt', ['asset-a-c0']);
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    const client = new KnowledgeClient(makeDeps(store, async ({ texts }) => {
      return { embeddings: texts.map(() => [1, 0]), dim: 2 };
    }));

    await expect(client.reembed({ embedding: REF, signal: controller.signal }))
      .rejects.toThrow('user cancelled');
  });
});
