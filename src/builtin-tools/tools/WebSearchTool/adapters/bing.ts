import { load, loadBuffer, type CheerioAPI } from 'cheerio';
import { readWebResponse } from '../../WebFetchTool/network/readWebResponse.js';
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js';

const SEARCH_TIMEOUT_MS = 30_000;
const HTML_RESPONSE_LIMIT = 5 * 1024 * 1024;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
} as const;

export const bingSearch: WebSearchAdapter = async (
  query: string,
  options: SearchOptions,
): Promise<SearchResult[]> => {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US`;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]);
  const res = await options.request(url, {
    signal,
    // Bing 会跳转到地区站点. 此请求不携带 API Key 或 Cookie, 跟随后再核对最终页面.
    redirect: 'follow',
    headers: BROWSER_HEADERS,
  });
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
    await res.body?.cancel();
    throw new Error('搜索响应不是 HTML 页面');
  }
  const body = await readWebResponse(res, HTML_RESPONSE_LIMIT, signal);
  const page = loadBuffer(body, { encoding: { defaultEncoding: 'utf-8' } });
  return readBingSearchPage(page, res.url);
};

function readBingSearchPage(page: CheerioAPI, pageUrl: string): SearchResult[] {
  const url = new URL(pageUrl);
  const captchaAddress = /^\/turing\/captcha(?:\/|$)/i.test(url.pathname);
  const captchaElement = page('#b_captcha, #b_captcha_frame').length > 0;
  if (captchaAddress || captchaElement) {
    throw new Error('搜索请求需要网页验证, 当前无法读取搜索结果');
  }

  const bingHost = url.hostname === 'bing.com' || url.hostname.endsWith('.bing.com');
  if (!bingHost || !/^\/search\/?$/i.test(url.pathname)) {
    throw new Error('搜索请求跳转到了非 Bing 搜索页面');
  }

  const resultsContainer = page('ol#b_results').length > 0;
  if (!resultsContainer) {
    throw new Error('无法识别搜索页面, 页面结构可能已经变化');
  }
  const results = readResultElements(page);
  if (results.length > 0) {
    return results;
  }

  // b_no 是搜索页明确显示的无结果提示. 只有空列表时也可能是解析规则失效, 不能返回无结果.
  const noResults = page('#b_results li.b_no').length > 0;
  if (noResults) {
    return [];
  }
  throw new Error('无法识别搜索页面, 页面结构可能已经变化');
}

/** 只提取 b_algo 中的网页条目. 空数组不代表搜索确实无结果, 页面判断由请求入口负责. */
export function extractBingResults(html: string): SearchResult[] {
  return readResultElements(load(html));
}

function readResultElements(page: CheerioAPI): SearchResult[] {
  const results: SearchResult[] = [];
  for (const element of page('li.b_algo').toArray()) {
    const block = page(element);
    const link = block.find('h2 a[href]').first();
    const rawUrl = link.attr('href');
    if (!rawUrl) {
      continue;
    }
    const url = resolveBingUrl(rawUrl);
    if (!url) {
      continue;
    }

    const title = link.text().replace(/\s+/gu, ' ').trim();
    let snippet = '';
    // 优先读摘要段落, 没有时再读摘要容器. Cheerio 负责嵌套标签和字符实体.
    for (const selector of ['p.b_lineclamp', '.b_caption p', '.b_caption']) {
      snippet = block.find(selector).first().text().replace(/\s+/gu, ' ').trim();
      if (snippet) {
        break;
      }
    }

    results.push({ title, url, snippet });
  }
  return results;
}

/**
 * Bing /ck/a 的 u 参数是带 a1/a0 前缀的 base64url 目标地址.
 * 只在 Bing 跳转链接上解码, 不改其他网站名称也叫 u 的查询参数.
 */
export function resolveBingUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl, 'https://www.bing.com');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    const bingHost = url.hostname === 'bing.com' || url.hostname.endsWith('.bing.com');
    if (!bingHost) {
      return url.toString();
    }
    const encoded = url.searchParams.get('u');
    if (url.pathname !== '/ck/a' || !encoded || !/^a[01]/u.test(encoded)) {
      return undefined;
    }
    const target = new URL(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'));
    if (target.protocol === 'http:' || target.protocol === 'https:') {
      return target.toString();
    }
  } catch {
    // 地址或跳转参数无效时忽略该条目, 不把 Bing 站内链接交给模型.
  }
  return undefined;
}
