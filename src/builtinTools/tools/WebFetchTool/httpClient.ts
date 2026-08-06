// 这里把公共 HTTP 响应收紧为 WebFetchTool 可以返回的文本网页, 并缓存转换结果。
import { fetchPublicResource, PublicHttpPolicyError } from '@ema-agent/public-http';
import { WebPageCache } from './cache.js';
import { htmlToMarkdown } from './htmlToMarkdown.js';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface FetchedPage {
  finalUrl: string;
  /** 转换后的内容(Markdown 或原始 HTML)。 */
  content: string;
  contentType: string;
  bytes: number;
  status: number;
  statusText: string;
}

export interface FetchPageOptions {
  /** true 时缓存并返回原始 HTML, 不做 Markdown 转换。 */
  raw: boolean;
}

export async function fetchPublicPage(
  rawUrl: string,
  signal: AbortSignal,
  options: FetchPageOptions,
): Promise<FetchedPage> {
  // 缓存按调用方原始 URL 区分 raw/markdown, 命中后不再下载也不再转换。
  const cacheKey = `${options.raw ? 'raw:' : 'md:'}${rawUrl}`;
  const cached = WebPageCache.get(cacheKey);
  if (cached) {
    return {
      finalUrl: cached.finalUrl,
      content: cached.content,
      contentType: cached.contentType,
      bytes: cached.bytes,
      status: cached.code,
      statusText: cached.codeText,
    };
  }

  const response = await fetchPublicResource(upgradeToHttps(rawUrl), {
    signal,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
    maxRedirects: 5,
    headers: {
      Accept: 'text/markdown, text/html, text/plain, application/json, application/xml',
    },
  });
  const contentType = String(response.headers['content-type'] ?? 'application/octet-stream');
  if (!isTextContent(contentType)) {
    throw new PublicHttpPolicyError(`不支持读取二进制内容: ${contentType}`);
  }
  const content = options.raw
    ? response.body.toString('utf8')
    : await htmlToMarkdown(response.body.toString('utf8'));

  const entry = {
    finalUrl: response.finalUrl,
    content,
    contentType,
    bytes: response.body.byteLength,
    code: response.status,
    codeText: response.statusText,
  };
  // 缓存体积按转换后内容计; lru-cache 要求 size 为正整数, 空响应钳到 1。
  WebPageCache.set(cacheKey, entry, { size: Math.max(1, Buffer.byteLength(content)) });

  return {
    finalUrl: entry.finalUrl,
    content: entry.content,
    contentType: entry.contentType,
    bytes: entry.bytes,
    status: entry.code,
    statusText: entry.codeText,
  };
}

/** http 自动升级 https(Claude 同款); 只支持 https 的站点会如实报 https 侧错误。 */
function upgradeToHttps(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    return url.toString();
  }
  return rawUrl;
}

function isTextContent(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('javascript');
}
