// 单站点索引拉取:协议校验 + 原生 fetch + 304 + 条件请求。
// 只在用户打开市场页/手动检查时调用;启动与 Agent Loop 零网络。
import { parseSiteIndex, type SkillSite, type SkillSiteIndex } from './siteStore.js';

const INDEX_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export type SiteFetchResult =
  | { kind: 'notModified' }
  | { kind: 'ok'; index: SkillSiteIndex; etag: string | null; lastModified: string | null }
  | { kind: 'failed'; error: string };

export interface SiteIndexResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** 网络出口类型:测试注入替身;默认实现走原生 fetch。 */
export type SiteIndexFetcher = (
  url: string,
  options: { timeoutMs: number; maxBytes: number; headers: Record<string, string> },
) => Promise<SiteIndexResponse>;

const defaultFetcher: SiteIndexFetcher = async (url, options) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: options.headers,
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > options.maxBytes) {
    throw new Error(`站点索引响应体超过 ${options.maxBytes} 字节上限`);
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return { status: response.status, headers, body };
};

export async function fetchSiteIndex(
  site: SkillSite,
  fetcher: SiteIndexFetcher = defaultFetcher,
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
