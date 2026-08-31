// 按已配置凭据选择搜索后端, 并统一做域名过滤、URL 归一、去重与错误映射。
// 未来配置源换成 Settings + Credential 时, 只改本文件的 resolveSearchProvider。
import { bingSearch } from './bing.js';
import { braveSearch } from './brave.js';
import { SearchHttpStatusError } from './types.js';
import type { SearchOptions, SearchProgress, SearchResult } from './types.js';

export type { SearchOptions, SearchProgress, SearchResult } from './types.js';

/** 展示给用户/模型的后端名; 未来 Settings 的 provider 选值沿用同一枚举。 */
export type SearchProvider = 'brave' | 'bing';

/** 返回给模型的结果条数上限; 请求侧多取, 域名过滤后仍够用。 */
export const RESULT_LIMIT = 10;

interface ResolvedAdapter {
  readonly provider: SearchProvider;
  readonly search: (
    query: string,
    options: SearchOptions,
  ) => Promise<SearchResult[]>;
}

/** 凭据优先级: 有 Brave key 走 API, 否则回落零配置的 Bing HTML scrape。 */
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

/** 唯一搜索入口: 进度事件 → 后端调用 → 共享过滤/归一/去重 → 有界错误。 */
export async function searchWeb(
  query: string,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const adapter = resolveAdapter();
  options.onProgress?.({ type: 'query_update', query });
  let raw: SearchResult[];
  try {
    raw = await adapter.search(query, options);
  } catch (error) {
    // 取消不是 provider 失败: 原样上抛, 让执行层按取消关账, 不包装成搜索失败。
    if (options.signal.aborted) throw error;
    throw formatProviderError(adapter.provider, error);
  }
  const results = filterAndNormalize(raw, options);
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

/** 把后端错误翻译成模型/用户可操作的提示。 */
export function formatProviderError(
  provider: SearchProvider,
  error: unknown,
): Error {
  const label = PROVIDER_LABELS[provider];
  if (error instanceof SearchHttpStatusError) {
    const keyHint = provider === 'brave' && (error.status === 401 || error.status === 403)
      ? '，请检查 API key'
      : error.status === 429
        ? '，请求被限流，稍后重试'
        : '';
    return new Error(`${label} 搜索失败(${error.status})${keyHint}`);
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new Error(`${label} 搜索超时`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${label} 搜索失败: ${message}`);
}

/**
 * 域名过滤(精确或任意子域) + 协议校验 + URL 去重 + 长度截断。
 * 三个后端共用; 域名规整只做 trim/lowercase/去重, 形状校验归 Tool.validateInput。
 */
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
    if (!url) continue;
    const hostname = new URL(url).hostname;
    if (allowed.length > 0 && !allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      continue;
    }
    if (blocked.length > 0 && blocked.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: entry.title.slice(0, 500),
      url,
      snippet: entry.snippet.slice(0, 300),
    });
    if (results.length >= RESULT_LIMIT) break;
  }
  return results;
}

export function normalizeDomains(
  domains: readonly string[] | undefined,
): string[] {
  if (!domains) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const domain of domains) {
    const value = domain.trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizePublicResultUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}
