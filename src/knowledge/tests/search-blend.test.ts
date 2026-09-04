// 测试 KB 检索的 RRF 与 rerank 加权混合：低 rerank 分不消失、混合下限守卫空答案。

import { describe, expect, it } from 'vitest';
import { KnowledgeClient } from '../client.js';
import type { KnowledgeClientDeps } from '../client.js';
import type { KnowledgeStore } from '../store/store.js';
import type { CallEmbed, CallRerank, DocumentAsset, DocumentChunk } from '../types.js';

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

  /** 混合排序测试不走向量:嵌入清单恒空,内存索引为空,dense 路无命中。 */
  getAllEmbeddings(): Array<{ id: string; assetId: string; embedding: Buffer }> {
    return [];
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
): CallRerank {
  return async () => ({ results });
}

function failingReranker(): CallRerank {
  return async () => {
    throw new Error('rerank down');
  };
}

/** Embedding 硬门槛下检索必须有可用 embed;该桩提供空 dense 路(内存索引为空)。 */
function stubEmbed(): CallEmbed {
  return async () => ({
    embeddings: [[1, 0]],
    dim: 2,
    space: { id: 'blend-space', providerId: 'test', model: 'test', dim: 2 },
  });
}

function makeDeps(store: BlendStore, callRerank?: CallRerank): KnowledgeClientDeps {
  return {
    store: store as unknown as KnowledgeStore,
    resolveEmbed: () => stubEmbed(),
    resolveRerank: () => callRerank,
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

  it('rerank 调用失败如实向上传播,不退回未重排结果', async () => {
    const store = prepare();
    const client = new KnowledgeClient(makeDeps(store, failingReranker()));

    await expect(client.search('query', { topK: 2 })).rejects.toThrow('rerank down');
  });

  it('未配置 rerank 时直接按 RRF 顺序截断', async () => {
    const store = prepare();
    const client = new KnowledgeClient(makeDeps(store));

    const result = await client.search('query', { topK: 2 });

    expect(result.hits.map((h) => h.chunkId)).toEqual(['chunk-a', 'chunk-b']);
  });

  it('全部候选都送重排拿分,不付钱给不参赛的文档', async () => {
    const store = prepare();
    let seenTopK: number | undefined;
    let seenDocCount = 0;
    const spyReranker: CallRerank = async (request) => {
      seenTopK = request.topK;
      seenDocCount = request.documents.length;
      return { results: request.documents.map((_, index) => ({ index, score: 0.5 })) };
    };
    const client = new KnowledgeClient(makeDeps(store, spyReranker));

    await client.search('query', { topK: 2 });

    // RRF 候选 topK*2=4 条全部送进去;重排拿分范围=候选全集。
    expect(seenDocCount).toBe(3);
    expect(seenTopK).toBe(3);
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
    const failingEmbed: CallEmbed = async () => {
      throw new Error('socket closed');
    };
    const client = new KnowledgeClient({
      ...makeDeps(store),
      resolveEmbed: () => failingEmbed,
    });

    await expect(client.search('query', { topK: 2, signal: controller.signal }))
      .rejects.toThrow('user cancelled');
  });
});
