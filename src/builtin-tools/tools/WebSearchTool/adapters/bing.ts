import { decodeHtmlEntities } from './html.js';
import { SearchHttpStatusError } from './types.js';
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js';

const SEARCH_TIMEOUT_MS = 30_000;
const HTML_RESPONSE_LIMIT = 2 * 1024 * 1024;

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
  const res = await fetch(url, {
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]),
    // Bing 会跳转到地区站点. 此请求不携带 API Key 或 Cookie, 跟随后再核对最终页面.
    redirect: 'follow',
    headers: BROWSER_HEADERS,
  });
  if (res.status !== 200) {
    // 不使用的响应停止下载, 让 HTTP 连接及时释放.
    await res.body?.cancel();
    throw new SearchHttpStatusError(res.status);
  }
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
    await res.body?.cancel();
    throw new Error('搜索响应不是 HTML 页面');
  }
  const body = await res.arrayBuffer();
  if (body.byteLength > HTML_RESPONSE_LIMIT) {
    throw new Error(`搜索响应体超过 ${HTML_RESPONSE_LIMIT} 字节上限`);
  }
  return readBingSearchPage(Buffer.from(body).toString('utf8'), res.url);
};

function readBingSearchPage(html: string, pageUrl: string): SearchResult[] {
  const url = new URL(pageUrl);
  const captchaAddress = /^\/turing\/captcha(?:\/|$)/i.test(url.pathname);
  const captchaElement = /<(?:div|form|iframe)\b[^>]*\sid\s*=\s*(["'])b_captcha(?:_frame)?\1/i.test(html);
  if (captchaAddress || captchaElement) {
    throw new Error('搜索请求需要网页验证, 当前无法读取搜索结果');
  }

  const bingHost = url.hostname === 'bing.com' || url.hostname.endsWith('.bing.com');
  if (!bingHost || !/^\/search\/?$/i.test(url.pathname)) {
    throw new Error('搜索请求跳转到了非 Bing 搜索页面');
  }

  const resultsContainer = /<ol\b[^>]*\sid\s*=\s*(["'])b_results\1/i.test(html);
  if (!resultsContainer) {
    throw new Error('无法识别搜索页面, 页面结构可能已经变化');
  }
  const results = extractBingResults(html);
  if (results.length > 0) {
    return results;
  }

  // b_no 是搜索页明确显示的无结果提示. 只有空列表时也可能是解析规则失效, 不能返回无结果.
  const noResults = /<li\b[^>]*\sclass\s*=\s*(["'])(?:[^"']*\s)?b_no(?:\s[^"']*)?\1/i.test(html);
  if (noResults) {
    return [];
  }
  throw new Error('无法识别搜索页面, 页面结构可能已经变化');
}

/** 只提取 b_algo 中的网页条目. 空数组不代表搜索确实无结果, 页面判断由请求入口负责. */
export function extractBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const algoBlockRe = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = algoBlockRe.exec(html)) !== null) {
    const block = blockMatch[1]!;
    const h2LinkRe = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    const linkMatch = h2LinkRe.exec(block);
    if (!linkMatch) continue;

    const rawUrl = decodeHtmlEntities(linkMatch[1]!);
    const title = decodeHtmlEntities(linkMatch[2]!.replace(/<[^>]+>/g, '').trim());
    const url = resolveBingUrl(rawUrl);
    if (!url) continue;

    results.push({ title, url, snippet: extractSnippet(block) });
  }
  return results;
}

/**
 * 解析 Bing 跳转: /ck/a 的 `u` 参数是带 a1/a0 前缀的 base64url 编码目标.
 * 站内与相对链接丢弃, 直接外链原样保留.
 */
export function resolveBingUrl(rawUrl: string): string | undefined {
  if (rawUrl.startsWith('/') || rawUrl.startsWith('#')) return undefined;

  const uMatch = rawUrl.match(/[?&]u=([a-zA-Z0-9+/_=-]+)/);
  if (uMatch) {
    const encoded = uMatch[1]!;
    if (encoded.length >= 3) {
      const b64 = encoded.slice(2);
      try {
        const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(padded, 'base64').toString('utf-8');
        if (decoded.startsWith('http')) return decoded;
      } catch {
        // 非法的 base64 不是有效跳转, 落到下面的直链判断.
      }
    }
  }

  if (!rawUrl.includes('bing.com')) return rawUrl;
  return undefined;
}

/** snippet 三段提取: b_lineclamp <p> -> b_caption <p> -> b_caption 文本兜底. */
function extractSnippet(block: string): string {
  const lineclamp = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  if (lineclamp) {
    return decodeHtmlEntities(lineclamp[1]!.replace(/<[^>]+>/g, '').trim());
  }
  const captionP = /<div[^>]*class="b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  if (captionP) {
    return decodeHtmlEntities(captionP[1]!.replace(/<[^>]+>/g, '').trim());
  }
  const captionDiv = /<div[^>]*class="b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
  if (captionDiv) {
    const text = captionDiv[1]!.replace(/<[^>]+>/g, '').trim();
    if (text) return decodeHtmlEntities(text);
  }
  return '';
}
