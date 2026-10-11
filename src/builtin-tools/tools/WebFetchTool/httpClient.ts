import { WebPageCache } from './cache.js';
import { htmlToMarkdown } from './htmlToMarkdown.js';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface FetchedPage {
  finalUrl: string;
  /** 转换后的内容(Markdown 或原始 HTML). */
  content: string;
  contentType: string;
  bytes: number;
  status: number;
  statusText: string;
}

export interface FetchPageOptions {
  /** true 时缓存并返回原始 HTML, 不做 Markdown 转换. */
  raw: boolean;
}

export async function fetchPublicPage(
  rawUrl: string,
  signal: AbortSignal,
  options: FetchPageOptions,
): Promise<FetchedPage> {
  // 缓存按调用方原始 URL 区分 raw/markdown, 命中后不再下载也不再转换.
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

  const response = await fetch(upgradeToHttps(rawUrl), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    headers: {
      Accept: 'text/markdown, text/html, text/plain, application/json, application/xml',
    },
    redirect: 'follow',
  });
  if (!response.ok) {
    // 错误页面不能作为网页正文或写入缓存; 取消未读取的响应体, 不继续下载它.
    await response.body?.cancel();
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    throw new Error(`网页读取失败: HTTP ${response.status}${statusText}`);
  }

  const rawBody = await response.arrayBuffer();
  if (rawBody.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error(`响应体超过 ${MAX_RESPONSE_BYTES} 字节上限`);
  }
  const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').toLowerCase();
  if (!isTextContent(contentType)) {
    throw new Error(`不支持读取二进制内容: ${contentType}`);
  }
  const body = Buffer.from(rawBody);
  const content = options.raw
    ? body.toString('utf8')
    : await htmlToMarkdown(body.toString('utf8'));

  const entry = {
    finalUrl: response.url,
    content,
    contentType,
    bytes: body.byteLength,
    code: response.status,
    codeText: response.statusText,
  };
  // 缓存体积按转换后内容计; lru-cache 要求 size 为正整数, 空响应按 1 字节计.
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

/** HTTP 地址先改用 HTTPS 请求, 不回退到未加密连接. */
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
