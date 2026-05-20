import type { VectorIndex, SearchHit } from './vector-index.js';

// ── Lazy usearch loader ──────────────────────────────────────────────────────
//
// `usearch` is an **optional** dependency. On platforms with prebuilt binaries
// (macOS, Linux x64/arm64) it loads cleanly and gives us HNSW. On Windows the
// install step fails silently (we ignore node-gyp errors) and trying to
// instantiate the Index will throw. The lazy loader catches both failure
// modes and returns `null`; the factory then falls back to BruteForceIndex.

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

async function loadUsearch(): Promise<UsearchModule | null> {
  if (cached !== undefined) return cached;
  try {
    // Dynamic import so TypeScript doesn't hard-require the package and the
    // bundler can split it. `as unknown as` because usearch's exported types
    // are richer than what we use here.
    const mod = await import('usearch');
    cached = mod as unknown as UsearchModule;
  } catch {
    cached = null;
  }
  return cached;
}

// ── UsearchIndex implementation ──────────────────────────────────────────────

/**
 * HNSW-backed vector index. Created via `createUsearchIndex(dim)` — which
 * returns `null` if the native binary is missing, so the caller can fall
 * back to BruteForceIndex without a try/catch wrapper.
 */
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
        metric:            mod.MetricKind.IP,        // inner product
        quantization:      mod.ScalarKind.F32,
        connectivity:      16,
        expansion_add:     128,
        expansion_search:  64,
        multi:             false,
      });
      return new UsearchIndex(handle, dim);
    } catch {
      // Native instantiation failed (e.g. .node binary missing on Windows).
      // Memoise so we don't pay the import cost again.
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

  update(id: string, vec: Float32Array): void {
    // usearch.add() with an existing key overwrites the stored vector.
    this.add(id, vec);
  }

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
      const key  = result.keys[i]!;
      // usearch pads short result sets with -1n / very negative distances
      if (key === BigInt(-1) || key === BigInt('18446744073709551615')) continue;
      const id = this.keyToUuid.get(key);
      if (!id) continue;
      hits.push({ id, score: result.distances[i]! });
    }
    return hits;
  }

  size(): number {
    const raw = this.handle.size();
    return typeof raw === 'bigint' ? Number(raw) : raw;
  }
}
