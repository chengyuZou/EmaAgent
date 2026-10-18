import { hc, type ClientResponse } from 'hono/client';
import type { AppType } from '@ema-agent/server/routes';
import { tauriBridge } from '../lib/tauri/tauriBridge.js';


export interface ServerClient {
  /** Resolve the server base URL (`http://127.0.0.1:<port>`). */
  baseUrl(): Promise<string>;

  /** Force re-discover the port (e.g. after server restart). */
  refreshPort(): Promise<void>;

  /** 返回原始响应, 用于 SSE, 文件字节和 multipart 上传. 非 2xx 抛出 ServerApiError. */
  requestRaw(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;

  /** 原生 audio 使用的完整地址; 仅后端允许的音频 GET 路由接受 URL 里的现有口令. */
  audioUrl(path: string): Promise<string>;

  /** 构建浏览器 WebSocket URL; 浏览器不能设置认证 header, 因此密钥只放在 loopback 握手查询串. */
  webSocketUrl(path: string): Promise<string>;

}

export class ServerApiError extends Error {
  status: number;
  code?: string;
  /** 领域错误的细分原因(如 CharacterResourceValidationError 的 reason). */
  reason?: string;
  details?: unknown;
  /** 409 冲突类错误的具体冲突列表(如 model_in_use 的 ProviderBindingConflict[]). */
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
      // Ema 路由约定 error 字段即机器错误码(如 character_not_found),用它兜底 code.
      if (!code && typeof parsed.error === 'string' && /^[a-z0-9_/-]+$/i.test(parsed.error)) {
        code = parsed.error;
      }
      // 展示文案优先取后端人话 message, 机器码只作兜底.
      if (typeof parsed.message === 'string' && parsed.message.length > 0) {
        message = parsed.message;
      } else if (typeof parsed.error === 'string') {
        message = parsed.error;
      }
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


// Tauri 从宿主读取动态端口; 普通浏览器预览仍使用 3421.
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

/** server 重启换端口后清掉端口缓存, 下次请求重新发现(tsx watch 每次重启都换端口). */
async function refreshPortDiscovery(): Promise<void> {
  portPromise = null;
  await getPortPromise();
}


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
    // server 重启换端口后旧端口连接失败: 重新发现端口重试一次, 再不行才报不可达.
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

// 这里只要求状态和正文读取方法, Hono ClientResponse 和原生 Response 都能传入.

export async function toServerApiError(res: { status: number; text(): Promise<string> }): Promise<ServerApiError> {
  const text = await res.text().catch(() => '');
  return new ServerApiError(res.status, text);
}

// Hono 的成功响应可能把 ok 推导为 boolean, 直接提取 { ok: true } 会漏掉它.
// 因此只排除明确的 { ok: false } 成员, 保留其余响应的 JSON 类型.

type SuccessfulJson<T> = T extends { readonly ok: false }
  ? never
  : T extends { json(): Promise<infer Body> } ? Body : never;

/** 从 hc 端点方法类型提取成功响应载荷(排除错误状态成员). */
export type RpcJson<T extends (...args: never) => unknown> = SuccessfulJson<Awaited<ReturnType<T>>>;

/** 读取成功 JSON; 非 2xx 统一抛 ServerApiError. */
export async function readRpcJson<T extends ClientResponse<unknown, number, 'json'>>(
  request: Promise<T>,
): Promise<SuccessfulJson<T>> {
  const response = await request;
  if (!response.ok) throw await toServerApiError(response);
  return response.json() as Promise<SuccessfulJson<T>>;
}

/** 204/无内容端点: 只验状态, 不读 body. */
export async function readRpcVoid(request: Promise<ClientResponse<unknown>>): Promise<void> {
  const response = await request;
  if (!response.ok) throw await toServerApiError(response);
}

// hc<AppType> 需要静态 baseUrl, 但实际端口从 Tauri get_server_port 读取.
// 因此用占位 host 打底, 在自定义 fetch 包装里换成真实 origin, 并注入共享密钥头.
const RPC_HOST_PLACEHOLDER = 'http://ema-server';

// 这里只导入路由类型, Server 实现不会进入 WebView 的构建产物.
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
