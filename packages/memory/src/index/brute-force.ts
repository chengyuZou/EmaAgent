import type { VectorIndex, SearchHit } from './vector-index.js';
import { dotProduct } from '../embed/similarity.js';

/**
 * Brute-force vector index. Pure JS, no native deps. O(N) per query.
 *
 * Fast enough for ≤ 50 k entries at 1536 dim (V8 JIT keeps the tight loop in
 * the ballpark of ~1 GFLOPS). Beyond that the usearch backend should be used.
 */
export class BruteForceIndex implements VectorIndex {
  readonly backend = 'brute-force' as const;
  private readonly entries = new Map<string, Float32Array>();

  constructor(readonly dim: number) {}

  add(id: string, vec: Float32Array): void {
    if (vec.length !== this.dim) return;
    this.entries.set(id, vec);
  }

  update(id: string, vec: Float32Array): void {
    this.add(id, vec);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  search(query: Float32Array, k: number): SearchHit[] {
    if (query.length !== this.dim || k <= 0) return [];

    // Maintain a small running top-K to avoid sorting the whole table when
    // entry count grows large. For k = 10 this is materially faster than
    // full sort once N > ~1000.
    const top: SearchHit[] = [];
    let worstScore = -Infinity;

    for (const [id, vec] of this.entries) {
      const score = dotProduct(query, vec);
      if (top.length < k) {
        top.push({ id, score });
        if (top.length === k) {
          top.sort((a, b) => a.score - b.score);
          worstScore = top[0]!.score;
        }
        continue;
      }
      if (score <= worstScore) continue;
      // Replace the worst entry and re-sort (k is small, ~10 — sort cost is fine)
      top[0] = { id, score };
      top.sort((a, b) => a.score - b.score);
      worstScore = top[0]!.score;
    }

    return top.sort((a, b) => b.score - a.score);
  }

  size(): number {
    return this.entries.size;
  }
}
