import { WebPageCache } from './cache.js';
import { readWebResponse } from '../readWebResponse.js';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface FetchedPage {
  finalUrl: string;
  /** HTML 主体转为 Markdown, 非 HTML 文本或 raw 模式保留解码后的原文. */
  content: string;
  contentType: string;
  bytes: number;
  status: number;
  statusText: string;
}

export interface FetchPageOptions {
  /** true 时返回解码后的原始文本, 不提取主体或转换 Markdown. */
  raw: boolean;
}

export async function fetchPublicPage(
  rawUrl: string,
  signal: AbortSignal,
  options: FetchPageOptions,
): Promise<FetchedPage> {
  signal.throwIfAborted();
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

  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  const response = await fetch(upgradeToHttps(rawUrl), {
    signal: requestSignal,
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

  const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').toLowerCase();
  if (!isTextContent(contentType)) {
    await response.body?.cancel();
    throw new Error(`不支持读取二进制内容: ${contentType}`);
  }
  const body = await readWebResponse(response, MAX_RESPONSE_BYTES, requestSignal);
  // Windows 本地测量: 解析模块及其依赖独立导入约 1.7s, 实际耗时随环境变化.
  // 收到有效响应后才加载, 避免工具注册时提前承担这段开销; 命中缓存时无需再次导入.
  const { extractPageContent } = await import('./extractPageContent.js');
  requestSignal.throwIfAborted();
  const content = await extractPageContent(body, contentType, response.url, options.raw);
  requestSignal.throwIfAborted();

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
  const normalized = contentType.split(';')[0]!.trim().toLowerCase();
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('javascript');
}
