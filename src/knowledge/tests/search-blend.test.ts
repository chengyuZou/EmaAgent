// 测试 KB 检索的 RRF 与 rerank 加权混合：低 rerank 分不消失、混合下限守卫空答案。

import { describe, expect, it } from 'vitest';
import type { Reranker } from '@ema-agent/rerank';
import type { EmbeddingModel } from '@ema-agent/embed';
import { KnowledgeClient } from '../client.js';
import type { KnowledgeClientDeps } from '../client.js';
import type { KnowledgeStore } from '../store/store.js';
import type { DocumentAsset, DocumentChunk } from '../types.js';

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
  } as DocumentAsset;
}

class BlendStore {
  readonly chunks = new Map<string, DocumentChunk>();
  readonly assets = new Map<string, DocumentAsset>();
  ftsHits: Array<{ chunkId: string; score: number }> = [];

  add(id: string, assetId: string, fileName: string, text: string): void {
    this.chunks.set(id, makeChunk(id, assetId, text));
    if (!this.assets.has(assetId)) {
      this.assets.set(assetId, makeAsset(assetId, fileName));
    }
  }

  searchFts(): Array<{ chunkId: string; score: number }> {
    return this.ftsHits;
  }

  getChunk(id: string): DocumentChunk | undefined {
    return this.chunks.get(id);
  }

  getAsset(id: string): DocumentAsset | undefined {
    return this.assets.get(id);
  }
}

function rerankerReturning(
  results: Array<{ index: number; score: number }>,
): Reranker {
  return {
    rerank: async () => ({ results }),
  } as unknown as Reranker;
}

function failingReranker(): Reranker {
  return {
    rerank: async () => {
      throw new Error('rerank down');
    },
  } as unknown as Reranker;
}

function makeDeps(store: BlendStore, reranker?: Reranker): KnowledgeClientDeps {
  return {
    store: store as unknown as KnowledgeStore,
    resolveEmbedding: () => undefined,
    resolveEmbeddingByRef: () => undefined,
    resolveReranker: reranker ? () => ({ model: 'rerank-model', reranker }) : () => undefined,
    resolveVision: () => undefined,
  };
}

describe('KB 检索混合排序', () => {
  function prepare() {
    const store = new BlendStore();
    store.add('chunk-a', 'asset-a', 'a.txt', 'alpha');
    store.add('chunk-b', 'asset-a', 'a.txt', 'beta');
    store.add('chunk-c', 'asset-a', 'a.txt', 'gamma');
    // FTS 命中三条，BM25 分递减（RRF 顺序 a > b > c）。
    store.ftsHits = [
      { chunkId: 'chunk-a', score: 3 },
      { chunkId: 'chunk-b', score: 2 },
      { chunkId: 'chunk-c', score: 1 },
    ];
    return store;
  }

  it('rerank 低分结果被压后而不是整条消失', async () => {
    const store = prepare();
    // rerank 只评了两条：b 高分、a 低分；c 未被 rerank 覆盖。
    const client = new KnowledgeClient(makeDeps(
      store,
      rerankerReturning([
        { index: 1, score: 0.9 },
        { index: 0, score: 0.1 },
      ]),
    ));

    const result = await client.search('query', { topK: 3 });

    // RRF 分按本批最高归一后三者接近（a≈1, b≈0.98, c≈0.97），混合分：
    //   b: 0.4*0.98 + 0.6*0.9 ≈ 0.93  → 第一
    //   a: 0.4*1.00 + 0.6*0.1 = 0.46  → 第二
    //   c: 0.4*0.97 + 0       ≈ 0.39  → 压后但不消失
    expect(result.hits.map((h) => h.chunkId)).toEqual(['chunk-b', 'chunk-a', 'chunk-c']);
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score);
    expect(result.hits[1]!.score).toBeGreaterThan(result.hits[2]!.score);
  });

  it('rerank 全部给 0 分时退回按 RRF 信号排序', async () => {
    const store = prepare();
    const client = new KnowledgeClient(makeDeps(
      store,
      rerankerReturning([
        { index: 0, score: 0 },
        { index: 1, score: 0 },
        { index: 2, score: 0 },
      ]),
    ));

    const result = await client.search('query', { topK: 2 });

    // rerank 分全为 0 时混合分 = 0.4 * rrfNorm，顺序与 RRF 一致。
    expect(result.hits.map((h) => h.chunkId)).toEqual(['chunk-a', 'chunk-b']);
  });

  it('rerank 调用失败时回退 RRF 顺序', async () => {
    const store = prepare();
    const client = new KnowledgeClient(makeDeps(store, failingReranker()));

    const result = await client.search('query', { topK: 2 });

    expect(result.hits.map((h) => h.chunkId)).toEqual(['chunk-a', 'chunk-b']);
  });

  it('未配置 rerank 时直接按 RRF 顺序截断', async () => {
    const store = prepare();
    const client = new KnowledgeClient(makeDeps(store));

    const result = await client.search('query', { topK: 2 });

    expect(result.hits.map((h) => h.chunkId)).toEqual(['chunk-a', 'chunk-b']);
  });

  it('rerank 期间的取消向上传播，不伪装成降级结果', async () => {
    const store = prepare();
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    // 真实客户端在 abort 后会以连接错误抛出；关键是 signal 已 abort。
    const client = new KnowledgeClient(makeDeps(store, failingReranker()));

    await expect(client.search('query', { topK: 2, signal: controller.signal }))
      .rejects.toThrow('user cancelled');
  });

  it('dense 路嵌入失败遇上取消同样向上传播', async () => {
    const store = prepare();
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    const client = new KnowledgeClient({
      ...makeDeps(store),
      resolveEmbedding: () => ({
        providerId: 'p',
        model: 'm',
        embedding: {
          embed: async () => {
            throw new Error('socket closed');
          },
        } as unknown as EmbeddingModel,
      }),
    });

    await expect(client.search('query', { topK: 2, signal: controller.signal }))
      .rejects.toThrow('user cancelled');
  });
});
