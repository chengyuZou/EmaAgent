// 基于 lru-cache 的函数记忆化:LRU 淘汰防止无界增长;peek 只观察不提升热度。
// 对照 Claude src/utils/memoize.ts 的 memoizeWithLRU,只保留我们需要的 LRU 变体。
import { LRUCache } from 'lru-cache';

export interface LruMemoized<Args extends unknown[], Result> {
  (...args: Args): Result;
  readonly cache: {
    clear(): void;
    size(): number;
    delete(key: string): boolean;
    /** peek 不更新 recency——只想观察缓存,不想把它刷成热数据。 */
    get(key: string): Result | undefined;
    has(key: string): boolean;
  };
}

export function memoizeWithLRU<Args extends unknown[], Result extends NonNullable<unknown>>(
  f: (...args: Args) => Result,
  cacheKey: (...args: Args) => string,
  maxCacheSize = 100,
): LruMemoized<Args, Result> {
  const cache = new LRUCache<string, Result>({ max: maxCacheSize });

  const memoized = (...args: Args): Result => {
    const key = cacheKey(...args);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = f(...args);
    cache.set(key, result);
    return result;
  };

  memoized.cache = {
    clear: () => cache.clear(),
    size: () => cache.size,
    delete: (key: string) => cache.delete(key),
    get: (key: string) => cache.peek(key),
    has: (key: string) => cache.has(key),
  };

  return memoized;
}
