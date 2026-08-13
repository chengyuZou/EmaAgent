import type { VectorIndex, SearchHit } from './vector-index.js';

interface UsearchModule {
  Index: new (config: {
    dimensions:        number;
    metric:            string;
    quantization:      string;
    connectivity:      number;
    expansion_add:     number;
    expansion_search:  number;
    multi:             boolean;
  }) => UsearchHandle;
  MetricKind: { IP: string };
  ScalarKind: { F32: string };
}

interface UsearchHandle {
  add(key: bigint, vector: Float32Array, threads?: number): void;
  search(vector: Float32Array, k: number, threads?: number): {
    keys: BigUint64Array;
    distances: Float32Array;
  };
  remove(key: bigint, threads?: number): void;
  size(): bigint | number;
}

let cached: UsearchModule | null | undefined = undefined;

/**
 * USearch 的 IP 指标返回 `1 - innerProduct` 距离；VectorIndex 对外则统一
 * 使用“越大越相似”的分数。转换必须留在适配器边界，避免上层感知底层实现。
 */
export function innerProductDistanceToSimilarity(distance: number): number {
  return 1 - distance;
}

async function loadUsearch(): Promise<UsearchModule | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = await import('usearch');
    cached = mod as unknown as UsearchModule;
  } catch (err) {
    console.warn('[kb] usearch native module unavailable, using brute-force index:',
      err instanceof Error ? err.message : err);
    cached = null;
  }
  return cached;
}

export class UsearchIndex implements VectorIndex {
  readonly backend = 'usearch' as const;
  private readonly uuidToKey = new Map<string, bigint>();
  private readonly keyToUuid = new Map<bigint, string>();
  private nextKey = 1n;

  private constructor(
    private readonly handle: UsearchHandle,
    readonly dim: number,
  ) {}

  static async create(dim: number): Promise<UsearchIndex | null> {
    const mod = await loadUsearch();
    if (!mod) return null;
    try {
      const handle = new mod.Index({
        dimensions:        dim,
        metric:            mod.MetricKind.IP,
        quantization:      mod.ScalarKind.F32,
        connectivity:      16,
        expansion_add:     128,
        expansion_search:  64,
        multi:             false,
      });
      return new UsearchIndex(handle, dim);
    } catch {
      cached = null;
      return null;
    }
  }

  add(id: string, vec: Float32Array): void {
    if (vec.length !== this.dim) return;
    let key = this.uuidToKey.get(id);
    if (key === undefined) {
      key = this.nextKey++;
      this.uuidToKey.set(id, key);
      this.keyToUuid.set(key, id);
    }
    this.handle.add(key, vec);
  }

  update(id: string, vec: Float32Array): void { this.add(id, vec); }

  remove(id: string): void {
    const key = this.uuidToKey.get(id);
    if (key === undefined) return;
    this.handle.remove(key);
    this.uuidToKey.delete(id);
    this.keyToUuid.delete(key);
  }

  search(query: Float32Array, k: number): SearchHit[] {
    if (query.length !== this.dim || k <= 0) return [];
    const result = this.handle.search(query, k);
    const hits: SearchHit[] = [];
    for (let i = 0; i < result.keys.length; i++) {
      const key = result.keys[i]!;
      if (key === BigInt(-1) || key === BigInt('18446744073709551615')) continue;
      const id = this.keyToUuid.get(key);
      if (!id) continue;
      hits.push({
        id,
        score: innerProductDistanceToSimilarity(result.distances[i]!),
      });
    }
    return hits;
  }

  size(): number {
    const raw = this.handle.size();
    return typeof raw === 'bigint' ? Number(raw) : raw;
  }
}
