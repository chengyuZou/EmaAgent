import type { VectorIndex, SearchHit } from './vector-index.js';

function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export class BruteForceIndex implements VectorIndex {
  readonly backend = 'brute-force' as const;
  private readonly entries = new Map<string, Float32Array>();

  constructor(readonly dim: number) {}

  add(id: string, vec: Float32Array): void {
    if (vec.length !== this.dim) return;
    this.entries.set(id, vec);
  }

  update(id: string, vec: Float32Array): void { this.add(id, vec); }

  remove(id: string): void { this.entries.delete(id); }

  search(query: Float32Array, k: number): SearchHit[] {
    if (query.length !== this.dim || k <= 0) return [];

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
      top[0] = { id, score };
      top.sort((a, b) => a.score - b.score);
      worstScore = top[0]!.score;
    }

    return top.sort((a, b) => b.score - a.score);
  }

  size(): number { return this.entries.size; }
}
