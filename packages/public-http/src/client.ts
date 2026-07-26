// 使用 DNS 审批后的固定 IP 发起公网请求, 并限制重定向, 时间和响应字节数.
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import {
  PublicHttpLimitError,
  PublicHttpPolicyError,
  PublicHttpStatusError,
} from './errors.js';
import type { PublicHttpRequestOptions, PublicHttpResponse } from './types.js';
import { approvePublicTarget, assertSafePublicRedirect } from './url-policy.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

// 轻量并发闸门: 防 Agent 失控时几十上百个公网请求同时起飞,
// 把自己的内存和上游服务器一起打爆(单请求限字节不等于系统安全)。
const MAX_CONCURRENT_GLOBAL = 8;
const MAX_CONCURRENT_PER_HOST = 2;
const MAX_QUEUED = 32;

// 调用方允许补充的请求头(白名单); 其余一律剥离,
// 防 Host/Cookie/Authorization/连接指令外发或覆盖安全默认头。
const CALLER_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'if-none-match',
  'if-modified-since',
]);

// 即使调用方显式追加白名单，也不能覆盖路由、连接和消息边界头。
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export async function fetchPublicResource(
  rawUrl: string,
  options: PublicHttpRequestOptions,
): Promise<PublicHttpResponse> {
  assertPositiveInteger('maxBytes', options.maxBytes);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  assertPositiveInteger('timeoutMs', timeoutMs);
  assertNonNegativeInteger('maxRedirects', maxRedirects);
  if ((options.additionalAllowedHeaders?.length ?? 0) > 0 && maxRedirects !== 0) {
    throw new PublicHttpPolicyError('携带额外敏感请求头时必须禁用自动重定向');
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  let current = rawUrl;

  // 重定向被严格限制在同主机, 所以整个循环可以用同一个 host 键控并发闸门。
  const hostKey = (() => {
    try { return new URL(rawUrl).hostname.toLowerCase(); } catch { return ''; }
  })();
  const release = await egressLimiter.acquire(hostKey, signal);
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      // DNS 查询本身没有 AbortSignal 参数, 通过竞速保证调用链可以按时退出.
      // 即使底层系统解析稍后才返回, 也不会继续建立网络连接.
      const target = await waitForSignal(approvePublicTarget(current), signal);
      const response = await requestPinned(
        target.url,
        target.address,
        target.family,
        options.headers,
        signal,
        options.additionalAllowedHeaders,
      );
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
  } finally {
    release();
  }
}

/** 构建出站请求头; 导出仅供包内测试验证白名单边界. */
export function buildRequestHeaders(
  callerHeaders: Readonly<Record<string, string>> | undefined,
  additionalAllowed?: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept-Encoding': 'identity',
    'User-Agent': 'EmaAgent/1.0',
  };
  const allowed = additionalAllowed && additionalAllowed.length > 0
    ? new Set([
        ...CALLER_HEADER_ALLOWLIST,
        ...additionalAllowed
          .map(name => name.toLowerCase())
          .filter(name => !FORBIDDEN_REQUEST_HEADERS.has(name)),
      ])
    : CALLER_HEADER_ALLOWLIST;
  for (const [name, value] of Object.entries(callerHeaders ?? {})) {
    if (allowed.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

function requestPinned(
  url: URL,
  address: string,
  family: 4 | 6,
  headers: Readonly<Record<string, string>> | undefined,
  signal: AbortSignal,
  additionalAllowedHeaders?: readonly string[],
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
      headers: buildRequestHeaders(headers, additionalAllowedHeaders),
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

/** 全局+每 host 的轻量并发闸门(FIFO 排队, 可中止, 队满即拒); 导出仅供包内测试。 */
export class PublicEgressLimiter {
  private total = 0;
  private readonly byHost = new Map<string, number>();
  private readonly waiters: Array<{
    host: string;
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    onAbort: () => void;
  }> = [];

  async acquire(host: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason ?? new Error('公网请求已取消');
    if (this.canAcquire(host)) return this.grant(host);
    if (this.waiters.length >= MAX_QUEUED) {
      throw new PublicHttpLimitError('公网请求并发排队已满');
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        host,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason ?? new Error('公网请求已取消'));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private canAcquire(host: string): boolean {
    return this.total < MAX_CONCURRENT_GLOBAL
      && (this.byHost.get(host) ?? 0) < MAX_CONCURRENT_PER_HOST;
  }

  private grant(host: string): () => void {
    this.total++;
    this.byHost.set(host, (this.byHost.get(host) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total = Math.max(0, this.total - 1);
      const next = Math.max(0, (this.byHost.get(host) ?? 1) - 1);
      if (next === 0) this.byHost.delete(host);
      else this.byHost.set(host, next);
      this.drain();
    };
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!;
      if (waiter.signal.aborted) {
        this.waiters.splice(index, 1);
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(waiter.signal.reason ?? new Error('公网请求已取消'));
        continue;
      }
      if (!this.canAcquire(waiter.host)) {
        index++;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(this.grant(waiter.host));
    }
  }
}

const egressLimiter = new PublicEgressLimiter();
