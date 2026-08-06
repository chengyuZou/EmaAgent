// Bing HTML 兜底后端: 零 key 可用, 解析协议对照 Claude bingAdapter。
// 浏览器指纹头避免反爬返回 JS 渲染页; UA 属敏感头, 按 public-http 策略强制禁重定向。
import { fetchPublicResource } from '@ema-agent/public-http';
import { decodeHtmlEntities } from './html.js';
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
  const res = await fetchPublicResource(url, {
    signal: options.signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: HTML_RESPONSE_LIMIT,
    maxRedirects: 0,
    headers: BROWSER_HEADERS,
    additionalAllowedHeaders: [
      'user-agent',
      'cache-control',
      'pragma',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'sec-fetch-user',
      'upgrade-insecure-requests',
    ],
  });
  return extractBingResults(res.body.toString('utf8'));
};

/** Bing 有机结果在 <li class="b_algo"> 块内; 独立导出供 fixture 测试锁定解析。 */
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
 * 解析 Bing 跳转: /ck/a 的 `u` 参数是带 a1/a0 前缀的 base64url 编码目标,
 * 站内与相对链接丢弃, 直接外链原样保留。
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
        // 非法的 base64 不是有效跳转, 落到下面的直链判断。
      }
    }
  }

  if (!rawUrl.includes('bing.com')) return rawUrl;
  return undefined;
}

/** snippet 三段提取: b_lineclamp <p> → b_caption <p> → b_caption 文本兜底。 */
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
