import { describe, expect, it } from 'vitest';
import { BruteForceIndex } from '../src/index/brute-force.js';
import {
  innerProductDistanceToSimilarity,
  UsearchIndex,
} from '../src/index/usearch.js';

describe('B-013 USearch IP 分数契约', () => {
  it('把 IP 距离转换为越大越相似的分数', () => {
    expect(innerProductDistanceToSimilarity(0)).toBe(1);
    expect(innerProductDistanceToSimilarity(0.1)).toBeCloseTo(0.9);
    expect(innerProductDistanceToSimilarity(0.8)).toBeCloseTo(0.2);
    expect(innerProductDistanceToSimilarity(2)).toBe(-1);
  });

  it('转换后保持相似向量排在前面', () => {
    const closeScore = innerProductDistanceToSimilarity(0.1);
    const distantScore = innerProductDistanceToSimilarity(0.8);

    expect(closeScore).toBeGreaterThan(distantScore);
  });

  it('原生模块可用时与暴力索引保持相同排序和分数语义', async () => {
    const usearch = await UsearchIndex.create(2);
    if (!usearch) return;

    const bruteForce = new BruteForceIndex(2);
    const entries = [
      ['closest', new Float32Array([1, 0])],
      ['middle', new Float32Array([0.8, 0.6])],
      ['furthest', new Float32Array([0, 1])],
    ] as const;

    for (const [id, vector] of entries) {
      usearch.add(id, vector);
      bruteForce.add(id, vector);
    }

    const query = new Float32Array([1, 0]);
    const nativeHits = usearch.search(query, entries.length);
    const fallbackHits = bruteForce.search(query, entries.length);

    expect(nativeHits.map(hit => hit.id)).toEqual(fallbackHits.map(hit => hit.id));
    expect(nativeHits.map(hit => hit.score)).toEqual(
      fallbackHits.map(hit => expect.closeTo(hit.score, 5)),
    );
  });
});
