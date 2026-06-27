import type { VectorIndex } from './vector-index.js';
import { BruteForceIndex } from './brute-force.js';
import { UsearchIndex }   from './usearch.js';

/**
 * Create the best vector index available on this machine:
 *   - usearch (HNSW) if the native module loads — preferred for ≥ 10k entries
 *   - brute-force pure JS — always available as a fallback
 *
 * `force` lets tests pin one backend regardless of availability.
 */
export async function createVectorIndex(
  dim: number,
  force?: 'brute-force' | 'usearch',
): Promise<VectorIndex> {
  if (force === 'brute-force') return new BruteForceIndex(dim);
  if (force === 'usearch') {
    const u = await UsearchIndex.create(dim);
    if (!u) throw new Error('memory: usearch backend requested but unavailable');
    return u;
  }

  const u = await UsearchIndex.create(dim);
  return u ?? new BruteForceIndex(dim);
}
