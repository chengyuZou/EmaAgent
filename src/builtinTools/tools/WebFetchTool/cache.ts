// WebFetch 页面内容的 LRU 缓存: 15 分钟 TTL、50MB 上限, 避免重复下载与重复转换。
import { LRUCache } from 'lru-cache';

export interface CachedWebPage {
  /** 重定向后的最终 URL, 命中缓存时与首次请求保持一致。 */
  readonly finalUrl: string;
  readonly bytes: number;
  readonly code: number;
  readonly codeText: string;
  readonly contentType: string;
  /** 转换后的内容(Markdown 或 raw HTML), 缓存它避免二次转换。 */
  readonly content: string;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024;

export const WebPageCache = new LRUCache<string, CachedWebPage>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
});

export function clearWebFetchCache(): void {
  WebPageCache.clear();
}
