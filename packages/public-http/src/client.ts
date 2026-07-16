// 这里使用 DNS 审批后的固定 IP 发起公网请求, 并限制重定向, 时间和响应字节数.
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { PublicHttpLimitError, PublicHttpStatusError } from './errors.js';
import type { PublicHttpRequestOptions, PublicHttpResponse } from './types.js';
import { approvePublicTarget, assertSafePublicRedirect } from './url-policy.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

export async function fetchPublicResource(
  rawUrl: string,
  options: PublicHttpRequestOptions,
): Promise<PublicHttpResponse> {
  assertPositiveInteger('maxBytes', options.maxBytes);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  assertPositiveInteger('timeoutMs', timeoutMs);
  assertNonNegativeInteger('maxRedirects', maxRedirects);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  let current = rawUrl;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    // DNS 查询本身没有 AbortSignal 参数, 通过竞速保证调用链可以按时退出.
    // 即使底层系统解析稍后才返回, 也不会继续建立网络连接.
    const target = await waitForSignal(approvePublicTarget(current), signal);
    const response = await requestPinned(target.url, target.address, target.family, options.headers, signal);
    const status = response.statusCode ?? 0;
    const statusText = response.statusMessage ?? 'Unknown status';

    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new PublicHttpStatusError(status, 'Redirect without Location', current);
      if (redirects === maxRedirects) {
        throw new PublicHttpLimitError(`重定向次数超过 ${maxRedirects} 次`);
      }
      const next = new URL(location, target.url);
      assertSafePublicRedirect(target.url, next);
      current = next.toString();
      continue;
    }

    if (status < 200 || status >= 300) {
      response.destroy();
      throw new PublicHttpStatusError(status, statusText, current);
    }
    const body = await readBoundedResponseBody(response, options.maxBytes, signal);
    return {
      finalUrl: target.url.toString(),
      status,
      statusText,
      headers: response.headers,
      body,
    };
  }
  throw new PublicHttpLimitError(`重定向次数超过 ${maxRedirects} 次`);
}

function requestPinned(
  url: URL,
  address: string,
  family: 4 | 6,
  headers: Readonly<Record<string, string>> | undefined,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    // URL hostname 保留给 Host 与 TLS SNI, lookup 只返回刚才审批过的固定 IP,
    // 防止审批后再次解析到私网地址.
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        'Accept-Encoding': 'identity',
        'User-Agent': 'EmaAgent/1.0',
        ...headers,
      },
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      signal,
    };
    const request = transport.request(options, resolve);
    request.once('error', reject);
    request.end();
  });
}

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal, '公网请求已取消'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal, '公网请求已取消'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** 按声明长度和实际流量双重限制响应; 导出仅供包内测试验证底层边界. */
export async function readBoundedResponseBody(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const contentLength = Number(response.headers['content-length'] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.destroy();
    throw new PublicHttpLimitError(`响应体超过 ${maxBytes} 字节上限`);
  }
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
      response.destroy(abortReason(signal, '公网响应读取已取消'));
    };
    response.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        response.destroy(new PublicHttpLimitError(`响应体超过 ${maxBytes} 字节上限`));
        return;
      }
      chunks.push(buffer);
    });
    response.once('end', onEnd);
    response.once('error', onError);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} 必须是正整数`);
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} 必须是非负整数`);
}
