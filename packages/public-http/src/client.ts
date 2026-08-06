// 使用 Axios 执行经过公网审批的请求，并在每次重定向前重新验证目标。
import http from 'node:http';
import https from 'node:https';
import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios';
import {
  PublicHttpLimitError,
  PublicHttpStatusError,
  PublicHttpTimeoutError,
} from './errors.js';
import { publicEgressLimiter } from './egressLimiter.js';
import {
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertSensitiveHeaderRedirectPolicy,
  buildRequestHeaders,
  hasConditionalRequestHeader,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
} from './requestPolicy.js';
import type {
  ApprovedPublicTarget,
  PublicHttpHeaders,
  PublicHttpRequestOptions,
  PublicHttpResponse,
} from './types.js';
import { approvePublicTarget, assertSafePublicRedirect } from './url-policy.js';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

interface RequestOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  headers: Readonly<Record<string, string>>;
}

export async function fetchPublicResource(
  rawUrl: string,
  options: PublicHttpRequestOptions,
): Promise<PublicHttpResponse> {
  const requestOptions = prepareRequestOptions(options);
  const release = await publicEgressLimiter.acquire(hostKeyOf(rawUrl), requestOptions.signal);
  try {
    return await requestBuffer(rawUrl, requestOptions);
  } finally {
    release();
  }
}

async function requestBuffer(
  rawUrl: string,
  options: RequestOptions,
): Promise<PublicHttpResponse> {
  let current = rawUrl;
  for (let depth = 0; depth <= options.maxRedirects; depth++) {
    const target = await approvePublicTarget(current);
    const response = await axiosRequest<ArrayBuffer>(target, {
      ...options,
      responseType: 'arraybuffer',
    });
    const redirect = redirectTarget(response, target.url);
    if (redirect) {
      if (depth === options.maxRedirects) {
        throw new PublicHttpLimitError(`重定向次数超过 ${options.maxRedirects} 次`);
      }
      assertSafePublicRedirect(target.url, redirect);
      current = redirect.toString();
      continue;
    }

    const notModified = response.status === 304 && hasConditionalRequestHeader(options.headers);
    if ((response.status < 200 || response.status >= 300) && !notModified) {
      throw new PublicHttpStatusError(response.status, response.statusText, current);
    }
    return {
      finalUrl: target.url.toString(),
      status: response.status,
      statusText: response.statusText,
      headers: normalizeHeaders(response.headers),
      body: notModified ? Buffer.alloc(0) : Buffer.from(response.data),
    };
  }
  throw new PublicHttpLimitError(`重定向次数超过 ${options.maxRedirects} 次`);
}

async function axiosRequest<T>(
  target: ApprovedPublicTarget,
  options: RequestOptions & { responseType: 'arraybuffer' | 'stream' },
): Promise<AxiosResponse<T>> {
  const agent = createPinnedAgent(target);
  try {
    return await axios.request<T>({
      url: target.url.toString(),
      method: 'GET',
      adapter: 'http',
      responseType: options.responseType,
      headers: options.headers,
      signal: options.signal,
      timeout: options.timeoutMs,
      maxRedirects: 0,
      maxContentLength: options.maxBytes,
      decompress: false,
      proxy: false,
      validateStatus: () => true,
      ...(target.url.protocol === 'https:'
        ? { httpsAgent: agent }
        : { httpAgent: agent }),
    } satisfies AxiosRequestConfig);
  } catch (error) {
    throw normalizeAxiosError(error, options.timeoutMs, options.maxBytes);
  } finally {
    agent.destroy();
  }
}

function createPinnedAgent(target: ApprovedPublicTarget): http.Agent | https.Agent {
  const lookup: NonNullable<http.AgentOptions['lookup']> = (_hostname, _options, callback) => {
    callback(null, target.address, target.family);
  };
  return target.url.protocol === 'https:'
    ? new https.Agent({ lookup })
    : new http.Agent({ lookup });
}

function prepareRequestOptions(options: PublicHttpRequestOptions): RequestOptions {
  assertPositiveInteger('maxBytes', options.maxBytes);
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  assertPositiveInteger('timeoutMs', timeoutMs);
  assertNonNegativeInteger('maxRedirects', maxRedirects);
  assertSensitiveHeaderRedirectPolicy(options.additionalAllowedHeaders, maxRedirects);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal,
    timeoutMs,
    maxBytes: options.maxBytes,
    maxRedirects,
    headers: buildRequestHeaders(options.headers, options.additionalAllowedHeaders),
  };
}

function redirectTarget(response: AxiosResponse, previous: URL): URL | undefined {
  if (!REDIRECT_STATUS.has(response.status)) return undefined;
  const location = response.headers.location;
  if (!location) {
    throw new PublicHttpStatusError(response.status, 'Redirect missing Location header', previous.toString());
  }
  return new URL(String(location), previous);
}

function normalizeHeaders(headers: AxiosResponse['headers']): PublicHttpHeaders {
  // AxiosHeaders 实例与裸对象两种形态分别取规范小写键。
  const raw: Record<string, unknown> = headers instanceof AxiosHeaders
    ? headers.toJSON()
    : ((headers as Record<string, unknown>) ?? {});
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || typeof value === 'string' || Array.isArray(value)) {
      normalized[name.toLowerCase()] = value;
    } else {
      normalized[name.toLowerCase()] = String(value);
    }
  }
  return normalized;
}

function normalizeAxiosError(error: unknown, timeoutMs: number, maxBytes: number): unknown {
  if (!axios.isAxiosError(error)) return error;
  const axiosError = error as AxiosError;
  if (axiosError.code === AxiosError.ERR_CANCELED) return error;
  if (axiosError.code === AxiosError.ECONNABORTED || axiosError.code === AxiosError.ETIMEDOUT) {
    return new PublicHttpTimeoutError(timeoutMs);
  }
  if (axiosError.message.includes('maxContentLength')) {
    return new PublicHttpLimitError(`响应体超过 ${maxBytes} 字节上限`);
  }
  return error;
}

function hostKeyOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}
