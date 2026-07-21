// 这里为市场 Adapter 提供安全, 有界, 可取消并支持镜像降级的公网下载.
import { fetchPublicResource } from '@ema-agent/public-http';
import type { PublicHttpResponse } from '@ema-agent/public-http';

export interface FetchOpts {
  timeoutMs?: number;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** 下载到内存前允许读取的最大字节数. */
  maxBytes?: number;
}

export interface MarketFetchResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: PublicHttpResponse['headers'];
  readonly bytes: Uint8Array;
  text(): string;
  json<T>(): T;
  arrayBuffer(): ArrayBuffer;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_JSON_BYTES = 5 * 1024 * 1024;
const DEFAULT_TEXT_BYTES = 1024 * 1024;

/** 主地址确实失败时才尝试镜像; 调用方取消后绝不再产生第二次请求. */
export async function fetchWithMirror(
  url: string,
  mirrorUrl: string | undefined,
  opts: FetchOpts = {},
): Promise<MarketFetchResponse> {
  try {
    return toMarketResponse(await fetchOne(url, opts));
  } catch (primaryError) {
    if (!mirrorUrl || opts.signal?.aborted) throw primaryError;
    try {
      return toMarketResponse(await fetchOne(mirrorUrl, opts));
    } catch (mirrorError) {
      const primaryMessage = errorMessage(primaryError);
      const mirrorMessage = errorMessage(mirrorError);
      throw new Error(`市场主地址和镜像均请求失败; 主地址: ${primaryMessage}; 镜像: ${mirrorMessage}`, {
        cause: primaryError,
      });
    }
  }
}

export async function fetchJson<T>(
  url: string,
  mirrorUrl: string | undefined,
  opts: FetchOpts = {},
): Promise<T> {
  const response = await fetchWithMirror(url, mirrorUrl, {
    ...opts,
    maxBytes: opts.maxBytes ?? DEFAULT_JSON_BYTES,
    headers: { Accept: 'application/json', ...opts.headers },
  });
  return response.json<T>();
}

export async function fetchText(
  url: string,
  mirrorUrl: string | undefined,
  opts: FetchOpts = {},
): Promise<string> {
  const response = await fetchWithMirror(url, mirrorUrl, {
    ...opts,
    maxBytes: opts.maxBytes ?? DEFAULT_TEXT_BYTES,
    headers: { Accept: 'text/plain, text/markdown, */*', ...opts.headers },
  });
  return response.text();
}

export interface GitTreeNode {
  path: string;
  type: string;
  size?: number;
}

interface GitTreeResponse {
  tree?: Array<{ path: string; type: string; size?: number }>;
}

/** 通过 GitHub API 拉取仓库文件树; 响应同样经过公网与体积边界. */
export async function fetchGithubTree(
  owner: string,
  repo: string,
  ref: string,
  opts: FetchOpts = {},
): Promise<GitTreeNode[]> {
  const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const data = await fetchJson<GitTreeResponse>(api, undefined, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'EmaAgent/1.0',
      ...opts.headers,
    },
  });
  return data.tree ?? [];
}

/** 将 GitHub raw 文件地址转换为 jsDelivr 镜像地址. */
export function githubRawToJsdelivr(url: string): string | null {
  const match = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, owner, repo, ref, path] = match;
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${path}`;
}

function fetchOne(url: string, opts: FetchOpts): Promise<PublicHttpResponse> {
  return fetchPublicResource(url, {
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? DEFAULT_RESPONSE_BYTES,
    maxRedirects: 5,
    headers: opts.headers,
  });
}

function toMarketResponse(response: PublicHttpResponse): MarketFetchResponse {
  // 直接复用有界 Buffer 的底层视图, 避免 Bundle asset 在进入 Store 前再复制一份.
  const bytes = new Uint8Array(
    response.body.buffer,
    response.body.byteOffset,
    response.body.byteLength,
  );
  return {
    url: response.finalUrl,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    bytes,
    text: () => response.body.toString('utf8'),
    json: <T>() => JSON.parse(response.body.toString('utf8')) as T,
    arrayBuffer: () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
