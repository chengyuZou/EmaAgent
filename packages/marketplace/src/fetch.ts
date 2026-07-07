// ── 通用 fetch 基建(业务包 adapter 复用)──────────────────────────────────────
//
// 主 URL 失败降级 mirrorUrl(CN 友好 —— skill installer 已有此模式,提到通用层)。
// 所有 fetch 带 timeout,避免卡死聚合。

export interface FetchOpts {
  timeoutMs?: number;
  headers?:   Record<string, string>;
  /** 调用方取消信号(如用户中止安装)。与 timeoutMs 兜底合并,任一触发即中止。 */
  signal?:    AbortSignal;
}

const DEFAULT_TIMEOUT = 15_000;

/** 合并调用方 signal 与 timeout 兜底,任一触发即中止。无 signal 时只用 timeout。 */
function mergeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  // AbortSignal.any 浏览器/Node 18+ 都支持;若已被 abort 直接透传
  if (signal.aborted) return signal;
  return AbortSignal.any([signal, timeout]);
}

/** 主 URL 失败(网络错或非 2xx)则尝试 mirrorUrl。两者都失败抛主 URL 的错。 */
export async function fetchWithMirror(
  url:       string,
  mirrorUrl: string | undefined,
  opts:      FetchOpts = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT, headers, signal } = opts;
  try {
    const res = await fetch(url, {
      headers,
      signal: mergeSignal(signal, timeoutMs),
    });
    if (res.ok) return res;
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (!mirrorUrl) throw err;
    // 降级镜像
    const mirror = await fetch(mirrorUrl, {
      headers,
      signal: mergeSignal(signal, timeoutMs),
    });
    if (!mirror.ok) throw new Error(`HTTP ${mirror.status} (mirror also failed: ${(err as Error).message})`);
    return mirror;
  }
}

export async function fetchJson<T>(
  url:       string,
  mirrorUrl: string | undefined,
  opts:      FetchOpts = {},
): Promise<T> {
  const res = await fetchWithMirror(url, mirrorUrl, {
    ...opts,
    headers: { Accept: 'application/json', ...opts.headers },
  });
  return (await res.json()) as T;
}

export async function fetchText(
  url:       string,
  mirrorUrl: string | undefined,
  opts:      FetchOpts = {},
): Promise<string> {
  const res = await fetchWithMirror(url, mirrorUrl, {
    ...opts,
    headers: { Accept: 'text/plain, text/markdown, */*', ...opts.headers },
  });
  return res.text();
}

// ── GitHub git tree API ────────────────────────────────────────────────────────

export interface GitTreeNode {
  path: string;
  type: string;   // 'blob' | 'tree' | ...
  size?: number;
}

interface GitTreeResponse {
  tree?: Array<{ path: string; type: string; size?: number }>;
}

/**
 * 递归拉取仓库 git tree(一次请求拿全文件列表)。
 * owner/repo/ref 指定仓库。返回 blob 节点列表(业务包自行 filter 路径)。
 *
 * 注意:api.github.com 不被 jsDelivr 等 CDN 代理,所以此处不接 mirrorUrl ——
 * api 失败就抛错,调用方若需要可对 raw URL 单独走 githubRawToJsdelivr 降级。
 */
export async function fetchGithubTree(
  owner: string,
  repo:  string,
  ref:   string,
  opts:  FetchOpts = {},
): Promise<GitTreeNode[]> {
  const api = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const data = await fetchJson<GitTreeResponse>(api, undefined, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ema-agent', ...opts.headers },
  });
  return data.tree ?? [];
}

/**
 * raw.githubusercontent.com → jsDelivr CDN(中国可达)。
 * 返回 null 表示不是 GitHub raw URL。
 */
export function githubRawToJsdelivr(url: string): string | null {
  const m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, owner, repo, ref, path] = m;
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${path}`;
}
