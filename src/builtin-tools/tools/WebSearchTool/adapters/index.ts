import { domainToASCII } from 'node:url';
import { bingSearch } from './bing.js';
import { braveSearch } from './brave.js';
import { SearchHttpStatusError } from './types.js';
import type { SearchOptions, SearchProgress, SearchResult } from './types.js';

export type { SearchOptions, SearchProgress, SearchResult } from './types.js';

export type SearchProvider = 'brave' | 'bing';

/** 域名筛选和去重后, 返回给模型的结果条数上限. */
export const RESULT_LIMIT = 10;

interface ResolvedAdapter {
  readonly provider: SearchProvider;
  readonly search: (
    query: string,
    options: SearchOptions,
  ) => Promise<SearchResult[]>;
}

/** 有 Brave key 时使用 API, 否则读取 Bing 搜索页面. */
export function resolveSearchProvider(): SearchProvider {
  return hasBraveApiKey() ? 'brave' : 'bing';
}

function hasBraveApiKey(): boolean {
  return Boolean(
    process.env['BRAVE_SEARCH_API_KEY']?.trim()
    || process.env['BRAVE_API_KEY']?.trim(),
  );
}

function resolveAdapter(): ResolvedAdapter {
  const provider = resolveSearchProvider();
  switch (provider) {
    case 'brave':
      return { provider, search: braveSearch };
    case 'bing':
      return { provider, search: bingSearch };
  }
}

export async function searchWeb(
  query: string,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const adapter = resolveAdapter();
  options.onProgress?.({ type: 'query_update', query });
  let raw: SearchResult[];
  try {
    raw = await adapter.search(buildProviderQuery(query, options), options);
  } catch (error) {
    // 用户取消时保留原错误, 不把它显示为搜索服务失败.
    if (options.signal.aborted) {
      throw error;
    }
    throw formatProviderError(adapter.provider, error);
  }
  options.signal.throwIfAborted();
  const candidates = filterAndNormalize(raw, options);
  const results = candidates
    .slice(0, RESULT_LIMIT)
    .map(entry => ({
      title: entry.title.slice(0, 500),
      url: entry.url,
      snippet: entry.snippet.slice(0, 300),
    }));
  options.onProgress?.({
    type: 'search_results_received',
    query,
    resultCount: results.length,
  });
  return results;
}

const PROVIDER_LABELS: Readonly<Record<SearchProvider, string>> = {
  brave: 'Brave',
  bing: 'Bing',
};

export function formatProviderError(
  provider: SearchProvider,
  error: unknown,
): Error {
  const label = PROVIDER_LABELS[provider];
  if (error instanceof SearchHttpStatusError) {
    let keyHint = '';
    if (provider === 'brave' && (error.status === 401 || error.status === 403)) {
      keyHint = ', 请检查 API key';
    } else if (error.status === 429) {
      keyHint = ', 请求被限流, 稍后重试';
    }
    return new Error(`${label} 搜索失败(${error.status})${keyHint}`);
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new Error(`${label} 搜索超时`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${label} 搜索失败: ${message}`);
}

/** 按实际 URL 核对域名并去重, 保留搜索引擎返回的相对顺序. */
export function filterAndNormalize(
  raw: readonly SearchResult[],
  options: Pick<SearchOptions, 'allowedDomains' | 'blockedDomains'>,
): SearchResult[] {
  const allowed = normalizeDomains(options.allowedDomains);
  const blocked = normalizeDomains(options.blockedDomains);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const entry of raw) {
    const url = normalizePublicResultUrl(entry.url);
    if (!url) {
      continue;
    }
    const hostname = new URL(url).hostname;
    if (allowed.length > 0 && !allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      continue;
    }
    if (blocked.length > 0 && blocked.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    results.push({ title: entry.title, url, snippet: entry.snippet });
  }
  return results;
}

export function normalizeDomains(
  domains: readonly string[] | undefined,
): string[] {
  if (!domains) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const domain of domains) {
    const value = domainToASCII(domain.trim().toLowerCase());
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizePublicResultUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function buildProviderQuery(
  query: string,
  options: Pick<SearchOptions, 'allowedDomains' | 'blockedDomains'>,
): string {
  const allowed = normalizeDomains(options.allowedDomains);
  const blocked = normalizeDomains(options.blockedDomains);
  if (allowed.length === 0 && blocked.length === 0) {
    return query;
  }

  const clauses = [`(${query})`];
  if (allowed.length > 0) {
    clauses.push(`(${allowed.map(domain => `site:${domain}`).join(' OR ')})`);
  }
  for (const domain of blocked) {
    clauses.push(`NOT site:${domain}`);
  }
  // Bing/Brave 的域名操作符只是请求条件. 返回后仍按实际 URL 过滤, 不信任服务一定执行了条件.
  return clauses.join(' ');
}
