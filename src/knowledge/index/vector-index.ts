export interface VectorIndex {
  readonly backend: 'brute-force' | 'usearch';
  readonly dim: number;

  add(id: string, vec: Float32Array): void;
  update(id: string, vec: Float32Array): void;
  remove(id: string): void;

  /** Returns top-k matches by inner product (cosine for normalized vectors). Higher = more similar. */
  search(query: Float32Array, k: number): SearchHit[];

  size(): number;
}

export interface SearchHit {
  id: string;
  score: number;
}
