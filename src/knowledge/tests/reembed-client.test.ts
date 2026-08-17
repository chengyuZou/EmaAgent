// 测试单资产重嵌入：分批写向量、空间冻结与清理 stale、进度回调、abort 上抛、预检。

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

  add(assetId: string, fileName: string, chunkIds: string[]): void {
    this.assets.set(assetId, makeAsset(assetId, fileName));
    for (const id of chunkIds) this.chunks.set(id, makeChunk(id, assetId, `text-of-${id}`));
  }

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
}

function makeDeps(
  store: ReembedStore,
  embed: EmbeddingModel['embed'] | undefined,
): KnowledgeClientDeps {
  return {
    store: store as unknown as KnowledgeStore,
    resolveEmbedding: () => undefined,
    resolveEmbeddingByRef: () => (embed ? ({ embed }) as unknown as EmbeddingModel : undefined),
    resolveReranker: () => undefined,
    resolveVision: () => undefined,
  };
}

const REF = { providerId: 'provider-1', model: 'embed-1' };

describe('单资产重嵌入', () => {
  it('分批写向量并冻结空间、清理 stale、逐批报进度', async () => {
    const store = new ReembedStore();
    const chunkIds = Array.from({ length: 40 }, (_, index) => `chunk-${index}`);
    store.add('asset-a', 'a.txt', chunkIds);
    const client = new KnowledgeClient(makeDeps(store, async ({ texts }) => ({
      embeddings: texts.map(() => [1, 0]),
      dim: 2,
    })));
    const progress: Array<[number, number]> = [];

    const space = await client.reembedAsset('asset-a', REF, new AbortController().signal,
      (completed, total) => progress.push([completed, total]));

    expect(store.embedded.size).toBe(40);
    expect([...store.embedded.values()].every((value) => value.spaceId === space.id)).toBe(true);
    expect(store.assets.get('asset-a')!.embeddingSpaceId).toBe(space.id);
    expect(store.assets.get('asset-a')!.embeddingStale).toBe(false);
    // 40 块 = 32 + 8 两批，各报一次进度。
    expect(progress).toEqual([[32, 40], [40, 40]]);
  });

  it('abort 时把 signal 透给执行面并向上抛', async () => {
    const store = new ReembedStore();
    store.add('asset-a', 'a.txt', ['asset-a-c0']);
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    const client = new KnowledgeClient(makeDeps(store, async ({ signal }) => {
      throw signal?.aborted ? signal.reason : new Error('unreachable');
    }));

    await expect(client.reembedAsset('asset-a', REF, controller.signal))
      .rejects.toThrow('user cancelled');
    // 未冻结空间：资产保持 stale，retry 时整个资产重来。
    expect(store.assets.get('asset-a')!.embeddingStale).toBe(true);
  });

  it('模型配置缺失时抛未配置错误', async () => {
    const store = new ReembedStore();
    store.add('asset-a', 'a.txt', ['asset-a-c0']);
    const client = new KnowledgeClient(makeDeps(store, undefined));

    await expect(client.reembedAsset('asset-a', REF, new AbortController().signal))
      .rejects.toThrow('Embedding 配置已删除或模型未启用');
  });
});

describe('预检', () => {
  it('probeEmbeddingSpace 用响应维度构造空间', async () => {
    const store = new ReembedStore();
    const client = new KnowledgeClient(makeDeps(store, async ({ texts }) => {
      expect(texts).toHaveLength(1);
      return { embeddings: [[1, 0, 0]], dim: 3 };
    }));

    const space = await client.probeEmbeddingSpace(REF);
    expect(space.dim).toBe(3);
    expect(space.id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('模型配置缺失时预检直接失败', async () => {
    const store = new ReembedStore();
    const client = new KnowledgeClient(makeDeps(store, undefined));

    await expect(client.probeEmbeddingSpace(REF))
      .rejects.toThrow('Embedding 配置已删除或模型未启用');
  });
});
