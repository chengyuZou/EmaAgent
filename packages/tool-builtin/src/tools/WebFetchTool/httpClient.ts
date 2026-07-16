// 这里使用经过 DNS 审批后固定的 IP 发请求，并逐跳校验重定向和限制响应体。
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { approveWebTarget, assertSafeRedirect } from './urlPolicy.js';
import { WebFetchHttpError, WebFetchLimitError, WebFetchPolicyError } from './errors.js';

const MAX_REDIRECTS = 5;
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
  let current = rawUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const target = await approveWebTarget(current);
    const response = await requestPinned(target.url, target.address, target.family, signal);
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      response.resume();
      const location = response.headers.location;
      if (!location) throw new WebFetchHttpError(status, 'Redirect without Location', current);
      if (redirects === MAX_REDIRECTS) throw new WebFetchLimitError('重定向次数超过 5 次');
      const next = new URL(location, target.url);
      assertSafeRedirect(target.url, next);
      current = next.toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new WebFetchHttpError(status, response.statusMessage ?? 'Unknown status', current);
    }
    const contentLength = Number(response.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw new WebFetchLimitError(`响应体超过 ${MAX_RESPONSE_BYTES} 字节上限`);
    }
    const contentType = String(response.headers['content-type'] ?? 'application/octet-stream');
    if (!isTextContent(contentType)) {
      response.destroy();
      throw new WebFetchPolicyError(`不支持读取二进制内容：${contentType}`);
    }
    const body = await readBoundedBody(response, signal);
    return {
      finalUrl: target.url.toString(),
      body: body.toString('utf8'),
      contentType,
      bytes: body.byteLength,
      status,
    };
  }
  throw new WebFetchLimitError('重定向次数超过上限');
}

function requestPinned(
  url: URL,
  address: string,
  family: 4 | 6,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Accept: 'text/markdown, text/html, text/plain, application/json, application/xml',
        'Accept-Encoding': 'identity',
        'User-Agent': 'EmaAgent/1.0 (+https://github.com/ema-agent)',
      },
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      signal,
    };
    const request = transport.request(options, resolve);
    request.setTimeout(FETCH_TIMEOUT_MS, () => request.destroy(new Error('WebFetch 请求超时')));
    request.once('error', reject);
    request.end();
  });
}

function readBoundedBody(response: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      response.removeListener('end', onEnd);
      response.removeListener('error', onError);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, bytes));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      const reason = signal.reason instanceof Error ? signal.reason : new Error('WebFetch 请求已取消');
      response.destroy(reason);
    };
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        response.destroy(new WebFetchLimitError(`响应体超过 ${MAX_RESPONSE_BYTES} 字节上限`));
        return;
      }
      chunks.push(chunk);
    });
    response.once('end', onEnd);
    response.once('error', onError);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isTextContent(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('javascript');
}
