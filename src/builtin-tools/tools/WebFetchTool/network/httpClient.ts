import { stat } from 'node:fs/promises';
import { requestWeb } from './webRequests.js';
import { WebPageCache } from '../storage/cache.js';
import { readWebResponse } from './readWebResponse.js';
import { getSessionWebDownloadsDir, saveWebDownload, webDownloadNotice, type WebDownload } from '../storage/webDownloads.js';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface FetchedPage {
  finalUrl: string;
  /** HTML 主体转为 Markdown, 其他文本保留解码后的原文, 二进制返回下载说明. */
  content: string;
  contentType: string;
  bytes: number;
  status: number;
  statusText: string;
  download?: WebDownload;
}

export interface FetchPageOptions {
  /** Download files and their cache entries belong to the calling Session. */
  sessionId: string;
  /** true 时返回解码后的原始文本, 不提取主体或转换 Markdown. */
  raw: boolean;
}

export async function fetchPublicPage(
  rawUrl: string,
  signal: AbortSignal,
  options: FetchPageOptions,
): Promise<FetchedPage> {
  signal.throwIfAborted();
  const downloadsDir = getSessionWebDownloadsDir(options.sessionId);
  // 文本缓存区分 raw/markdown; 下载缓存与数据目录绑定, 不受文本分页方式影响.
  const cacheKey = `${options.raw ? 'raw:' : 'md:'}${rawUrl}`;
  const downloadKey = downloadsDir ? `file:${JSON.stringify([downloadsDir, rawUrl])}` : undefined;
  let cached = WebPageCache.get(cacheKey);
  if (!cached && downloadKey) {
    cached = WebPageCache.get(downloadKey);
    if (cached?.download) {
      const file = await stat(cached.download.filePath).catch(() => undefined);
      if (!file?.isFile() || file.size !== cached.bytes) {
        WebPageCache.delete(downloadKey);
        cached = undefined;
      }
    }
  }
  signal.throwIfAborted();
  if (cached) {
    return {
      finalUrl: cached.finalUrl,
      content: cached.content,
      contentType: cached.contentType,
      bytes: cached.bytes,
      status: cached.code,
      statusText: cached.codeText,
      ...(cached.download ? { download: cached.download } : {}),
    };
  }

  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  const response = await requestWeb(upgradeToHttps(rawUrl), {
    signal: requestSignal,
    headers: {
      Accept: 'text/markdown, text/html, text/plain, application/json, application/xml, */*;q=0.5',
    },
    redirect: 'follow',
  });
  const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').toLowerCase();
  const binary = !isTextContent(contentType);
  if (binary && !downloadsDir) {
    await response.body?.cancel();
    throw new Error('Web downloads are not configured by the host.');
  }
  const body = await readWebResponse(response, MAX_RESPONSE_BYTES, requestSignal);
  if (binary) {
    const download = await saveWebDownload(downloadsDir!, body, contentType, requestSignal);
    const content = webDownloadNotice(download, body.byteLength);
    const entry = {
      finalUrl: response.url,
      content,
      contentType: download.contentType,
      bytes: body.byteLength,
      code: response.status,
      codeText: response.statusText,
      download,
    };
    WebPageCache.set(downloadKey!, entry, { size: Buffer.byteLength(content) });
    return {
      finalUrl: entry.finalUrl,
      content,
      contentType: entry.contentType,
      bytes: entry.bytes,
      status: entry.code,
      statusText: entry.codeText,
      download,
    };
  }
  // Windows 本地测量: 解析模块及其依赖独立导入约 1.7s, 实际耗时随环境变化.
  // 收到有效响应后才加载, 避免工具注册时提前承担这段开销; 命中缓存时无需再次导入.
  const { extractPageContent } = await import('../content/extractPageContent.js');
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
    || normalized === 'application/json' || normalized.endsWith('+json')
    || normalized === 'application/xml' || normalized.endsWith('+xml')
    || normalized === 'application/javascript'
    || normalized === 'application/x-javascript'
    || normalized === 'application/x-www-form-urlencoded';
}
