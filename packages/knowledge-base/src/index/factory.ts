import type { VectorIndex } from './vector-index.js';
import { BruteForceIndex } from './brute-force.js';
import { UsearchIndex }    from './usearch.js';

export async function createVectorIndex(
  dim: number,
  force?: 'brute-force' | 'usearch',
): Promise<VectorIndex> {
  if (force === 'brute-force') return new BruteForceIndex(dim);
  if (force === 'usearch') {
    const u = await UsearchIndex.create(dim);
    if (!u) throw new Error('kb: usearch backend requested but unavailable');
    return u;
  }
  const u = await UsearchIndex.create(dim);
  return u ?? new BruteForceIndex(dim);
}
