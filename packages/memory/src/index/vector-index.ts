// ── VectorIndex interface ────────────────────────────────────────────────────

/**
 * A k-NN lookup over normalized embeddings keyed by UUID strings.
 *
 * Backends:
 *   - BruteForceIndex — pure JS, O(N) per query, always works.
 *   - UsearchIndex    — HNSW via the `usearch` native module, O(log N) per
 *                       query. Loaded lazily; falls back to brute force when
 *                       the native binary is unavailable (e.g. on a Windows
 *                       developer machine without MSVC).
 *
 * All inputs MUST be L2-normalized — we use dot product as the similarity
 * function, which is correct only for unit vectors. See `embed/similarity.ts`.
 */
export interface VectorIndex {
  readonly backend: 'brute-force' | 'usearch';
  readonly dim: number;

  add(id: string, vec: Float32Array): void;
  /** Same as add — present for self-documenting code. */
  update(id: string, vec: Float32Array): void;
  remove(id: string): void;

  /**
   * Returns the top-k matches by inner product (= cosine similarity for
   * normalized vectors). Higher score = more similar.
   * Score is in [-1, 1]; callers can filter by a threshold.
   */
  search(query: Float32Array, k: number): SearchHit[];

  size(): number;
}

export interface SearchHit {
  id: string;
  score: number;
}
