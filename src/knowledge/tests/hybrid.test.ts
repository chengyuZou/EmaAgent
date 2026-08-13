// 测试混合检索的 alpha 边界纯度与 RRF 融合。

import { describe, expect, it } from 'vitest';
import { weightedRank } from '../retrieval/hybrid.js';

describe('weightedRank', () => {
  const sparse = [
    { id: 's1', score: 3 },
    { id: 's2', score: 2 },
  ];
  const dense = [
    { id: 'd1', score: 0.9 },
    { id: 'd2', score: 0.8 },
    { id: 's1', score: 0.7 },
  ];

  it('alpha=0 是纯 BM25：向量侧候选不得以 0 分占位', () => {
    expect(weightedRank(sparse, dense, 0, 5).map((hit) => hit.id)).toEqual(['s1', 's2']);
  });

  it('alpha=1 是纯向量：BM25 侧候选不得以 0 分占位', () => {
    expect(weightedRank(sparse, dense, 1, 5).map((hit) => hit.id)).toEqual(['d1', 'd2', 's1']);
  });

  it('中间值按 RRF 融合，双路命中排最前', () => {
    expect(weightedRank(sparse, dense, 0.5, 3)[0]!.id).toBe('s1');
  });
});
