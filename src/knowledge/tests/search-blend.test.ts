// 测试 KB 检索的 RRF 与 rerank 加权混合：低 rerank 分不消失、混合下限守卫空答案。

import { describe, expect, it } from 'vitest';
import type { RerankRuntime } from '@ema-agent/rerank';
import { KnowledgeClient } from '../client.js';
import type { KnowledgeStore } from '../store/index.js';
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

function rerankRuntimeReturning(
  results: Array<{ index: number; score: number }>,
): RerankRuntime {
  return {
    rerank: async () => ({ results }),
  } as unknown as RerankRuntime;
}

function failingRerankRuntime(): RerankRuntime {
  return {
    rerank: async () => {
      throw new Error('rerank down');
    },
  } as unknown as RerankRuntime;
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
    const client = new KnowledgeClient({
      store: store as unknown as KnowledgeStore,
      rerankRuntime: rerankRuntimeReturning([
        { index: 1, score: 0.9 },
        { index: 0, score: 0.1 },
      ]),
      // 无 embedRuntime → 只有稀疏通道
    });

    const result = await client.search('query', {
      topK: 3,
      rerankProviderId: 'rerank-provider',
      rerankModel: 'rerank-model',
    });

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
    const client = new KnowledgeClient({
      store: store as unknown as KnowledgeStore,
      rerankRuntime: rerankRuntimeReturning([
        { index: 0, score: 0 },
        { index: 1, score: 0 },
        { index: 2, score: 0 },
      ]),
    });

    const result = await client.search('query', {
      topK: 2,
      rerankProviderId: 'rerank-provider',
      rerankModel: 'rerank-model',
    });

    // rerank 分全为 0 时混合分 = 0.4 * rrfNorm，顺序与 RRF 一致。
    expect(result.hits.map((h) => h.chunkId)).toEqual(['chunk-a', 'chunk-b']);
  });

  it('rerank 调用失败时回退 RRF 顺序', async () => {
    const store = prepare();
    const client = new KnowledgeClient({
      store: store as unknown as KnowledgeStore,
      rerankRuntime: failingRerankRuntime(),
    });

    const result = await client.search('query', {
      topK: 2,
      rerankProviderId: 'rerank-provider',
      rerankModel: 'rerank-model',
    });

    expect(result.hits.map((h) => h.chunkId)).toEqual(['chunk-a', 'chunk-b']);
  });

  it('未配置 rerank 时直接按 RRF 顺序截断', async () => {
    const store = prepare();
    const client = new KnowledgeClient({
      store: store as unknown as KnowledgeStore,
    });

    const result = await client.search('query', { topK: 2 });

    expect(result.hits.map((h) => h.chunkId)).toEqual(['chunk-a', 'chunk-b']);
  });
});
