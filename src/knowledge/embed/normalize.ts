/**
 * L2-normalize a raw embedding vector (number[]) from an embed provider.
 * Returns a new array; zero-vector is returned unchanged.
 *
 * After normalization, inner product equals cosine similarity, which is
 * required for correctness with the usearch IP metric and brute-force
 * dotProduct() inside the vector index.
 */
export function normalizeVec(vec: number[]): number[] {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  if (sumSq === 0) return vec;
  const inv = 1 / Math.sqrt(sumSq);
  return vec.map(v => v * inv);
}

/**
 * L2-normalize a Float32Array (returns a new copy).
 * Used when loading stored embeddings into the in-memory HNSW index so that
 * legacy (pre-normalization) rows are corrected on load without a DB migration.
 */
export function normalizeF32(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) { const v = vec[i]!; sumSq += v * v; }
  if (sumSq === 0) return vec;
  const inv = 1 / Math.sqrt(sumSq);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! * inv;
  return out;
}
