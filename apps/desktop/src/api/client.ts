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
import { tauriBridge } from '../lib/tauri/tauriBridge.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface ServerClient {
  /** Resolve the server base URL (`http://127.0.0.1:<port>`). */
  baseUrl(): Promise<string>;

  /** Force re-discover the port (e.g. after server restart). */
  refreshPort(): Promise<void>;

  /** 返回原始响应, 用于 SSE、文件字节和 multipart 上传. 非 2xx 抛出 ServerApiError. */
  requestRaw(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;

  /** 原生 audio 使用的完整地址; 仅后端允许的音频 GET 路由接受 URL 里的现有口令. */
  audioUrl(path: string): Promise<string>;

  /** 构建浏览器 WebSocket URL；浏览器不能设置认证 header，因此密钥只放在 loopback 握手查询串。 */
  webSocketUrl(path: string): Promise<string>;

}

export class ServerApiError extends Error {
  status: number;
  code?: string;
  /** 领域错误的细分原因(如 CharacterResourceValidationError 的 reason)。 */
  reason?: string;
  details?: unknown;
  /** 409 冲突类错误的具体冲突列表(如 model_in_use 的 ProviderBindingConflict[])。 */
  conflicts?: unknown[];

  constructor(status: number, body: string) {
    let code: string | undefined;
    let reason: string | undefined;
    let details: unknown;
    let conflicts: unknown[] | undefined;
    let message = `Server HTTP ${status}`;

    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      code = typeof parsed.code === 'string' ? parsed.code : undefined;
      reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
      details = parsed.details;
      conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : undefined;
      // Ema 路由约定 error 字段即机器错误码(如 character_not_found),用它兜底 code。
      if (!code && typeof parsed.error === 'string' && /^[a-z0-9_/-]+$/i.test(parsed.error)) {
        code = parsed.error;
      }
      // 展示文案优先取后端人话 message，机器码只作兜底。
      message = typeof parsed.message === 'string' && parsed.message.length > 0
        ? parsed.message
        : typeof parsed.error === 'string'
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
    this.conflicts = conflicts;
  }
}

// ── Port + secret discovery ───────────────────────────────────────────────────

const DEFAULT_PORT = 3421;
let portPromise:   Promise<number>      | null = null;
let secretPromise: Promise<string|null> | null = null;

async function discoverPort(): Promise<number> {
  const port = await tauriBridge.getServerPort();
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
    secretPromise = tauriBridge.getServerSecret().catch(() => null);
  }
  return secretPromise;
}

/** server 重启换端口后清掉端口缓存，下次请求重新发现（tsx watch 每次重启都换端口）。 */
async function refreshPortDiscovery(): Promise<void> {
  portPromise = null;
  await getPortPromise();
}

// ── Implementation ───────────────────────────────────────────────────────────

async function buildUrl(path: string): Promise<string> {
  const port = await getPortPromise();
  return new URL(path, `http://127.0.0.1:${port}`).toString();
}

// Hono 请求与字节流请求共用认证和端口重试. HTTP 错误响应留给各自的响应读取入口处理,
// 例如供应商探活需要同时读取 200 和 502 的结果, 不能在这里提前抛掉 502.
async function sendRequest(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const [url, secret] = await Promise.all([buildUrl(path), getSecretPromise()]);
  const requestInit = prepareRequestInit(init, secret);

  let res: Response;
  try {
    res = await fetch(url, requestInit);
  } catch (err: unknown) {
    // 用户取消不是端口失效, 不重新发现端口或重试已取消的试听.
    if (init?.signal?.aborted) {
      throw err;
    }
    // server 重启换端口后旧端口连接失败：重新发现端口重试一次，再不行才报不可达。
    try {
      await refreshPortDiscovery();
      const retryUrl = await buildUrl(path);
      res = await fetch(retryUrl, requestInit);
    } catch (retryErr: unknown) {
      if (init?.signal?.aborted) {
        throw retryErr;
      }
      const error = new Error(`Server unreachable: ${url}`);
      (error as Error & { cause?: unknown; code?: string }).cause = retryErr;
      (error as Error & { cause?: unknown; code?: string }).code = 'server_unreachable';
      throw error;
    }
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
// hc<AppType> 需要静态 baseUrl；端口是运行时发现（Tauri get_server_port），
// 因此用占位 host 打底，在自定义 fetch 包装里换成真实 origin，并注入共享密钥头。
const RPC_HOST_PLACEHOLDER = 'http://ema-server';

export const rpcClient = hc<AppType>(RPC_HOST_PLACEHOLDER, {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    let source: string;
    if (input instanceof Request) {
      source = input.url;
    } else {
      source = input.toString();
    }
    const url = new URL(source);
    return sendRequest(`${url.pathname}${url.search}`, init);
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

  async requestRaw(path: string, init?: RequestInit & { json?: unknown }): Promise<Response> {
    const response = await sendRequest(path, init);
    if (!response.ok) {
      throw await toServerApiError(response);
    }
    return response;
  },

  async audioUrl(path: string): Promise<string> {
    const [httpUrl, secret] = await Promise.all([buildUrl(path), getSecretPromise()]);
    const url = new URL(httpUrl);
    if (secret) url.searchParams.set('secret', secret);
    return url.toString();
  },

  async webSocketUrl(path: string): Promise<string> {
    const [httpUrl, secret] = await Promise.all([buildUrl(path), getSecretPromise()]);
    const url = new URL(httpUrl);
    url.protocol = 'ws:';
    if (secret) url.searchParams.set('secret', secret);
    return url.toString();
  },
};
