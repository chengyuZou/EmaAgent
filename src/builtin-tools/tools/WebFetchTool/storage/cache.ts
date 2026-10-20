import { LRUCache } from 'lru-cache';
import type { WebDownload } from './webDownloads.js';

export interface CachedWebPage {
  /** 重定向后的最终 URL, 命中缓存时与首次请求保持一致. */
  readonly finalUrl: string;
  readonly bytes: number;
  readonly code: number;
  readonly codeText: string;
  readonly contentType: string;
  /** 转换后的文本或下载说明. 不把二进制原文件放进内存缓存. */
  readonly content: string;
  /** Disk files outlive the cache. A missing file makes this entry unusable. */
  readonly download?: WebDownload;
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
