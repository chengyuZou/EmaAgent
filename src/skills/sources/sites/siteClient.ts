// 单站点索引拉取:协议校验 + public-http + 304 + 条件请求。
// 只在用户打开市场页/手动检查时调用;启动与 Agent Loop 零网络。
import { fetchPublicResource } from '@ema-agent/public-http';
import { parseSiteIndex, type SkillSite, type SkillSiteIndex } from './siteStore.js';

const INDEX_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export type SiteFetchResult =
  | { kind: 'notModified' }
  | { kind: 'ok'; index: SkillSiteIndex; etag: string | null; lastModified: string | null }
  | { kind: 'failed'; error: string };

/** 网络出口类型:与 public-http 的 fetchPublicResource 同形;测试注入替身。 */
export type SiteIndexFetcher = typeof fetchPublicResource;

export async function fetchSiteIndex(
  site: SkillSite,
  fetcher: SiteIndexFetcher = fetchPublicResource,
): Promise<SiteFetchResult> {
  const headers: Record<string, string> = {};
  if (site.etag) headers['If-None-Match'] = site.etag;
  if (site.lastModified) headers['If-Modified-Since'] = site.lastModified;

  let response;
  try {
    response = await fetcher(site.indexUrl, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: INDEX_MAX_BYTES,
      headers,
    });
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }

  if (response.status === 304) return { kind: 'notModified' };
  if (response.status !== 200) {
    return { kind: 'failed', error: `HTTP ${response.status}` };
  }

  try {
    const index = parseSiteIndex(response.body.toString('utf8'));
    return {
      kind: 'ok',
      index,
      etag: headerValue(response.headers, 'etag'),
      lastModified: headerValue(response.headers, 'last-modified'),
    };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}
