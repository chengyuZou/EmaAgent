// 这里把公共 HTTP 响应收紧为 WebFetchTool 可以返回给模型的文本网页.
import { fetchPublicResource, PublicHttpPolicyError } from '@ema-agent/public-http';

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export interface FetchedPage {
  finalUrl: string;
  body: string;
  contentType: string;
  bytes: number;
  status: number;
}

export async function fetchPublicPage(rawUrl: string, signal: AbortSignal): Promise<FetchedPage> {
  const response = await fetchPublicResource(rawUrl, {
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
  return {
    finalUrl: response.finalUrl,
    body: response.body.toString('utf8'),
    contentType,
    bytes: response.body.byteLength,
    status: response.status,
  };
}

function isTextContent(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('javascript');
}
