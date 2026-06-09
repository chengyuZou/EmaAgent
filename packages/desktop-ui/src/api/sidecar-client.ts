/**
 * Sidecar HTTP client — port discovery + fetch wrapper + error normalisation.
 *
 * Every `api/*.ts` module MUST route through this file. Direct `fetch()`
 * calls or hard-coded `http://127.0.0.1:3421` are forbidden.
 */

import { tauriBridge } from '../lib/tauri-bridge.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface SidecarClient {
  /** Resolve the sidecar base URL (`http://127.0.0.1:<port>`). */
  baseUrl(): Promise<string>;

  /** Force re-discover the port (e.g. after sidecar restart). */
  refreshPort(): Promise<void>;

  /** Typed JSON request. */
  request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>;

  /** Raw request that returns the Response object. */
  requestRaw(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;

  /** Build a full SSE URL with optional lastEventId query param. */
  streamUrl(path: string, params?: { lastEventId?: number }): Promise<string>;

  /** Returns headers required for authenticated requests (X-Ema-Secret). */
  getAuthHeaders(): Promise<Record<string, string>>;
}

export class SidecarApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(status: number, body: string) {
    let code: string | undefined;
    let details: unknown;
    let message = `Sidecar HTTP ${status}`;

    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      code = typeof parsed.code === 'string' ? parsed.code : undefined;
      details = parsed.details;
      message = typeof parsed.error === 'string'
        ? parsed.error
        : message;
    } catch {
      message = body.length > 200
        ? `${body.slice(0, 200)}…`
        : body;
    }

    super(message);
    this.name = 'SidecarApiError';
    this.status = status;
    this.code = code;
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

async function doRequest<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const [url, secret] = await Promise.all([buildUrl(path), getSecretPromise()]);
  const requestInit = prepareRequestInit(init, secret);

  let res: Response;
  try {
    res = await fetch(url, requestInit);
  } catch (err: unknown) {
    const error = new Error(`Sidecar unreachable: ${url}`);
    (error as Error & { cause?: unknown; code?: string }).cause = err;
    (error as Error & { cause?: unknown; code?: string }).code = 'sidecar_unreachable';
    throw error;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new SidecarApiError(res.status, text);
  }

  // 204 No Content
  if (res.status === 204) return undefined as unknown as T;

  return res.json() as Promise<T>;
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
    const error = new Error(`Sidecar unreachable: ${url}`);
    (error as Error & { cause?: unknown; code?: string }).cause = err;
    (error as Error & { cause?: unknown; code?: string }).code = 'sidecar_unreachable';
    throw error;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new SidecarApiError(res.status, text);
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

// ── Exported singleton ───────────────────────────────────────────────────────

export const sidecarClient: SidecarClient = {
  async baseUrl(): Promise<string> {
    const port = await getPortPromise();
    return `http://127.0.0.1:${port}`;
  },

  async refreshPort(): Promise<void> {
    portPromise = null;
    secretPromise = null;
    await getPortPromise();
  },

  request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
    return doRequest<T>(path, init);
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
