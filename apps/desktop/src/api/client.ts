/**
 * Server HTTP client — port discovery + fetch wrapper + error normalisation.
 *
 * Every `api/*.ts` module MUST route through this file. Direct `fetch()`
 * calls or hard-coded `http://127.0.0.1:3421` are forbidden.
 *
 * `rpcClient` is the Hono RPC client (`hc<AppType>`): route definitions are
 * the contract; the server implementation never enters the webview bundle
 * (`import type` evaporates at compile time).
 */

import { hc, type ClientResponse } from 'hono/client';
import type { AppType } from '@ema-agent/server/routes';
import { tauriBridge } from '../lib/tauri-bridge.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface ServerClient {
  /** Resolve the server base URL (`http://127.0.0.1:<port>`). */
  baseUrl(): Promise<string>;

  /** Force re-discover the port (e.g. after server restart). */
  refreshPort(): Promise<void>;

  /** Raw request that returns the Response object（SSE/流式/multipart 唯一逃生口）。 */
  requestRaw(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;

  /** Build a full SSE URL with optional lastEventId query param. */
  streamUrl(path: string, params?: { lastEventId?: number }): Promise<string>;

  /** Returns headers required for authenticated requests (X-Ema-Secret). */
  getAuthHeaders(): Promise<Record<string, string>>;
}

export class ServerApiError extends Error {
  status: number;
  code?: string;
  /** 领域错误的细分原因(如 CharacterResourceValidationError 的 reason)。 */
  reason?: string;
  details?: unknown;

  constructor(status: number, body: string) {
    let code: string | undefined;
    let reason: string | undefined;
    let details: unknown;
    let message = `Server HTTP ${status}`;

    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      code = typeof parsed.code === 'string' ? parsed.code : undefined;
      reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
      details = parsed.details;
      // Ema 路由约定 error 字段即机器错误码(如 character_not_found),用它兜底 code。
      if (!code && typeof parsed.error === 'string' && /^[a-z0-9_/-]+$/i.test(parsed.error)) {
        code = parsed.error;
      }
      message = typeof parsed.error === 'string'
        ? parsed.error
        : message;
    } catch {
      message = body.length > 200
        ? `${body.slice(0, 200)}…`
        : body;
    }

    super(message);
    this.name = 'ServerApiError';
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.details = details;
  }
}

// ── Port + secret discovery ───────────────────────────────────────────────────

const DEFAULT_PORT = 3421;
let portPromise:   Promise<number>      | null = null;
let secretPromise: Promise<string|null> | null = null;

async function discoverPort(): Promise<number> {
  const port = await tauriBridge.invoke<number>('get_sidecar_port');
  if (typeof port === 'number' && port > 0) return port;
  return DEFAULT_PORT;
}

function getPortPromise(): Promise<number> {
  if (!portPromise) {
    portPromise = discoverPort().catch((err: unknown) => {
      portPromise = null;
      throw err;
    });
  }
  return portPromise;
}

function getSecretPromise(): Promise<string | null> {
  if (!secretPromise) {
    secretPromise = tauriBridge.getSidecarSecret().catch(() => null);
  }
  return secretPromise;
}

// ── Implementation ───────────────────────────────────────────────────────────

async function buildUrl(path: string, params?: Record<string, string | number | undefined>): Promise<string> {
  const port = await getPortPromise();
  const url = new URL(path, `http://127.0.0.1:${port}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function doRequestRaw(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const [url, secret] = await Promise.all([buildUrl(path), getSecretPromise()]);
  const requestInit = prepareRequestInit(init, secret);

  let res: Response;
  try {
    res = await fetch(url, requestInit);
  } catch (err: unknown) {
    const error = new Error(`Server unreachable: ${url}`);
    (error as Error & { cause?: unknown; code?: string }).cause = err;
    (error as Error & { cause?: unknown; code?: string }).code = 'server_unreachable';
    throw error;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ServerApiError(res.status, text);
  }

  return res;
}

function prepareRequestInit(init?: RequestInit & { json?: unknown }, secret?: string | null): RequestInit {
  const headers = new Headers(init?.headers);
  if (secret) headers.set('X-Ema-Secret', secret);

  let body: BodyInit | undefined = init?.body ?? undefined;
  if (init?.json !== undefined && !body) {
    body = JSON.stringify(init.json);
    headers.set('Content-Type', 'application/json');
  }

  return { ...init, headers, body };
}

// ── RPC error helper ─────────────────────────────────────────────────────────
//
// hc 客户端返回 Response；域层薄封装把非 2xx 统一归一为 ServerApiError，
// 保证调用方只处理一种错误形状。参数取最小结构，兼容真 Response 与 hc ClientResponse。

export async function toServerApiError(res: { status: number; text(): Promise<string> }): Promise<ServerApiError> {
  const text = await res.text().catch(() => '');
  return new ServerApiError(res.status, text);
}

// ── RPC 解包 ─────────────────────────────────────────────────────────────────
//
// hono 的 ClientResponse 按状态字面量给 ok 标类型（ok: U extends 2xx ? true : ...），
// 成功分支不带显式状态码时 U=ContentfulStatusCode、ok 是 boolean——所以不能用
// `{ok:true}` 提取成功成员（会塌成 never），必须反向排除 `ok:false` 的错误成员。
// 同理 InferResponseType<T, 200> 对 ContentfulStatusCode 成员过滤结果也是 never，
// 域层一律改用 RpcJson 提取成功载荷。

type SuccessfulJson<T> = T extends { readonly ok: false }
  ? never
  : T extends { json(): Promise<infer Body> } ? Body : never;

/** 从 hc 端点方法类型提取成功响应载荷（排除错误状态成员）。 */
export type RpcJson<T extends (...args: never) => unknown> = SuccessfulJson<Awaited<ReturnType<T>>>;

/** 调用 hc 端点并解包成功 JSON；非 2xx 统一抛 ServerApiError。全仓唯一断言点。 */
export async function readRpcJson<T extends ClientResponse<unknown, number, 'json'>>(
  request: Promise<T>,
): Promise<SuccessfulJson<T>> {
  const response = await request;
  if (!response.ok) throw await toServerApiError(response);
  return response.json() as Promise<SuccessfulJson<T>>;
}

/** 204/无内容端点：只验状态，不读 body。 */
export async function readRpcVoid(request: Promise<ClientResponse<unknown>>): Promise<void> {
  const response = await request;
  if (!response.ok) throw await toServerApiError(response);
}

// ── RPC client ───────────────────────────────────────────────────────────────
//
// hc<AppType> 需要静态 baseUrl；端口是运行时发现（Tauri get_sidecar_port），
// 因此用占位 host 打底，在自定义 fetch 包装里换成真实 origin，并注入共享密钥头。
const RPC_HOST_PLACEHOLDER = 'http://ema-server';

export const rpcClient = hc<AppType>(RPC_HOST_PLACEHOLDER, {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const [base, secret] = await Promise.all([
      getPortPromise().then(port => `http://127.0.0.1:${port}`),
      getSecretPromise(),
    ]);
    const source = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.toString()
        : input;
    const url = source.replace(RPC_HOST_PLACEHOLDER, base);

    const headers = new Headers(init?.headers);
    if (secret) headers.set('X-Ema-Secret', secret);

    return fetch(url, { ...init, headers });
  },
});

export type RpcClient = typeof rpcClient;

// ── Exported singleton ───────────────────────────────────────────────────────

export const serverClient: ServerClient = {
  async baseUrl(): Promise<string> {
    const port = await getPortPromise();
    return `http://127.0.0.1:${port}`;
  },

  async refreshPort(): Promise<void> {
    portPromise = null;
    secretPromise = null;
    await getPortPromise();
  },

  requestRaw(path: string, init?: RequestInit & { json?: unknown }): Promise<Response> {
    return doRequestRaw(path, init);
  },

  async streamUrl(path: string, params?: { lastEventId?: number }): Promise<string> {
    return buildUrl(path, params as Record<string, string | number | undefined>);
  },

  async getAuthHeaders(): Promise<Record<string, string>> {
    const secret = await getSecretPromise();
    return secret ? { 'X-Ema-Secret': secret } : {};
  },
};
