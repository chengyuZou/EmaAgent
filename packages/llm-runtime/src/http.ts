/**
 * Provider HTTP 辅助函数。
 *
 * 这个模块只处理跨 provider 相同的事情：baseUrl 拼接、超时、JSON POST、
 * 错误归一化。各 adapter 自己负责 payload 和响应事件协议。
 */

import { LlmProviderError, responseToProviderError, unknownToProviderError } from "./errors.js";
import type { RuntimeFetch } from "./types.js";

export interface JsonPostOptions {
  providerId: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  fetchImpl?: RuntimeFetch;
  requestId?: string;
}

export interface JsonRequestOptions {
  providerId: string;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  fetchImpl?: RuntimeFetch;
  requestId?: string;
}

/** 规范化 baseUrl，避免调用端传入末尾斜杠导致路径拼接出错。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

/** 拼接 API URL，path 可以放心传 `/v1/messages` 或 `v1/messages`。 */
export function joinUrl(baseUrl: string, path: string): string {
  const cleanBase = normalizeBaseUrl(baseUrl);
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

/** 带连接超时和错误归一化的 JSON POST。 */
export async function postJson(options: JsonPostOptions): Promise<Response> {
  return requestJson({
    ...options,
    method: "POST",
  });
}

/** 带连接超时和错误归一化的 JSON 请求。 */
export async function requestJson(options: JsonRequestOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new LlmProviderError("No fetch implementation is available in this runtime.", {
      providerId: options.providerId,
      code: "network_error",
      requestId: options.requestId,
      retryable: false,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetchImpl(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw await responseToProviderError(options.providerId, response, options.requestId);
    }

    return response;
  } catch (error) {
    throw unknownToProviderError(options.providerId, error, options.requestId);
  } finally {
    clearTimeout(timeout);
  }
}

/** 读取 JSON 响应；空体或非法 JSON 直接归一化为 provider_internal。 */
export async function readJson<T>(providerId: string, response: Response, requestId?: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch (error) {
    throw new LlmProviderError(`${providerId} returned invalid JSON response.`, {
      providerId,
      code: "provider_internal",
      requestId,
      retryable: true,
      details: error,
    });
  }
}
