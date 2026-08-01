import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../database/database.js';
import { DocumentAssetRepo } from '../../repos/kb/document-asset.js';
import { DocumentChunkRepo } from '../../repos/kb/document-chunk.js';

const SPACE = 'space-test';

describe('B-072 embedding fallback 流式 Top-K', () => {
  let database: Database;
  let chunks: DocumentChunkRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'kb' });
    database.migrate();

    const assets = new DocumentAssetRepo(database.sqlite);
    for (const assetId of ['asset-a', 'asset-b']) {
      assets.insert({
        id: assetId,
        filePath: `files/${assetId}.txt`,
        fileName: `${assetId}.txt`,
        mimeType: 'text/plain',
        wordCount: 1,
        status: 'indexed',
        createdAt: 1,
        updatedAt: 1,
      });
      assets.setEmbeddingSpace(assetId, {
        id: SPACE,
        providerId: 'provider-test',
        model: 'model-test',
        dim: 2,
        normalization: 'l2',
        revision: 'provider-managed',
      });
    }

    chunks = new DocumentChunkRepo(database.sqlite);
    chunks.insertMany([
      makeChunk('chunk-a', 'asset-a'),
      makeChunk('chunk-b', 'asset-a'),
      makeChunk('chunk-c', 'asset-b'),
      makeChunk('chunk-d', 'asset-b'),
    ]);
    chunks.storeEmbedding('chunk-a', [1, 0], SPACE);
    chunks.storeEmbedding('chunk-b', [0.8, 0.2], SPACE);
    chunks.storeEmbedding('chunk-c', [0, 1], SPACE);
    chunks.storeEmbedding('chunk-d', [-1, 0], SPACE);
  });

  afterEach(() => database.close());

  it('返回与完整余弦排序一致的 Top-K', () => {
    const hits = chunks.searchByEmbedding([1, 0], SPACE, undefined, 3);

    expect(hits.map((hit) => hit.chunkId)).toEqual(['chunk-a', 'chunk-b', 'chunk-c']);
    expect(hits[0]!.score).toBeCloseTo(1);
    expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score);
  });

  it('asset scope 在流式扫描前由 SQL 过滤', () => {
    expect(chunks.searchByEmbedding([1, 0], SPACE, ['asset-b'], 10).map((hit) => hit.chunkId))
      .toEqual(['chunk-c', 'chunk-d']);
    expect(chunks.searchByEmbedding([1, 0], SPACE, [], 10)).toEqual([]);
  });

  it('超过单批上限的 asset scope 自动分批后仍返回全局 Top-K', () => {
    const assetIds = Array.from(
      { length: 1_001 },
      (_, index) => `missing-asset-${String(index).padStart(4, '0')}`,
    );
    assetIds[100] = 'asset-a';
    assetIds[900] = 'asset-b';

    expect(chunks.searchByEmbedding([1, 0], SPACE, assetIds, 3).map((hit) => hit.chunkId))
      .toEqual(['chunk-a', 'chunk-b', 'chunk-c']);
    expect(chunks.searchFts('chunk', assetIds, 10).map((hit) => hit.chunkId))
      .toEqual(['chunk-a', 'chunk-b', 'chunk-c', 'chunk-d']);
  });

  it('同分时按 chunkId 稳定排序且堆容量严格等于 K', () => {
    chunks.storeEmbedding('chunk-a', [1, 0], SPACE);
    chunks.storeEmbedding('chunk-b', [1, 0], SPACE);
    chunks.storeEmbedding('chunk-c', [1, 0], SPACE);

    expect(chunks.searchByEmbedding([1, 0], SPACE, undefined, 2).map((hit) => hit.chunkId))
      .toEqual(['chunk-a', 'chunk-b']);
  });

  it('固定容量堆与完整排序得到相同结果', () => {
    for (let index = 0; index < 101; index++) {
      const id = `bulk-${String(index).padStart(3, '0')}`;
      const vector = [
        ((index * 17) % 23) - 11,
        ((index * 29) % 31) - 15,
      ];
      chunks.insertMany([makeChunk(id, 'asset-a')]);
      chunks.storeEmbedding(id, vector, SPACE);
    }

    const allRows = database.sqlite.prepare(`
      SELECT id, embedding FROM document_chunks WHERE embedding IS NOT NULL
    `).all() as Array<{ id: string; embedding: Buffer }>;
    const expectedIds = allRows
      .map(({ id, embedding }) => {
        const x = embedding.readFloatLE(0);
        const y = embedding.readFloatLE(4);
        const norm = Math.hypot(x, y);
        return { chunkId: id, score: norm === 0 ? 0 : x / norm };
      })
      .sort((left, right) => right.score - left.score || compareId(left.chunkId, right.chunkId))
      .slice(0, 7)
      .map((hit) => hit.chunkId);
    const actualIds = chunks.searchByEmbedding([1, 0], SPACE, undefined, 7)
      .map((hit) => hit.chunkId);

    expect(actualIds).toEqual(expectedIds);
  });

  it('零向量、维度不匹配和非正 K 安全降级', () => {
    expect(chunks.searchByEmbedding([0, 0], SPACE, undefined, 1)[0]!.score).toBe(0);
    expect(chunks.searchByEmbedding([1, 0, 0], SPACE, undefined, 1)[0]!.score).toBe(0);
    expect(chunks.searchByEmbedding([1, 0], SPACE, undefined, 0)).toEqual([]);
    expect(chunks.searchByEmbedding([1, 0], SPACE, undefined, Number.NaN)).toEqual([]);
    expect(chunks.searchByEmbedding([1, 0], 'other-space', undefined, 10)).toEqual([]);
  });

  it('不会召回旧空间或已标记 stale 的文档向量', () => {
    chunks.storeEmbedding('chunk-a', [1, 0], 'legacy-space');
    expect(chunks.searchByEmbedding([1, 0], SPACE, undefined, 10).map((hit) => hit.chunkId))
      .not.toContain('chunk-a');

    database.sqlite.prepare('UPDATE document_assets SET ebd_stale = 1 WHERE id = ?').run('asset-b');
    expect(chunks.searchByEmbedding([1, 0], SPACE, undefined, 10).map((hit) => hit.chunkId))
      .not.toContain('chunk-c');
  });
});

function makeChunk(id: string, assetId: string) {
  return {
    id,
    assetId,
    text: id,
    blockKinds: ['paragraph'],
    tokenCount: 1,
    sectionPath: [],
  };
}

function compareId(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
