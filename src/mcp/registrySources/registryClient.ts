// 官方 MCP Registry(cursor 分页)的读取客户端,只认 v0 协议。
import { fetchPublicResource } from '@ema-agent/public-http';
import {
  RawRegistryServerSchema,
  type RawRegistryServer,
} from './types.js';

const MCP_REGISTRY_MAX_PAGES = 12;    // cursor 跟进次数上限
const MCP_REGISTRY_MAX_ENTRIES = 600; // 单源条目总量安全上限
const PAGE_LIMIT = 100;
const PAGE_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

/** 可注入的 JSON 拉取器,测试替换;默认走 public-http 公网防线。 */
export type RegistryJsonFetcher = (url: string, signal?: AbortSignal) => Promise<unknown>;

const defaultFetcher: RegistryJsonFetcher = async (url, signal) => {
  const response = await fetchPublicResource(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: PAGE_MAX_BYTES,
    signal,
    headers: { Accept: 'application/json' },
  });
  if (response.status !== 200) {
    throw new Error(`MCP Registry 请求失败(HTTP ${response.status}): ${url}`);
  }
  return JSON.parse(response.body.toString('utf8')) as unknown;
};

export interface RegistryListResult {
  entries: RawRegistryServer[];
  /** 因 Schema 不符被跳过的条目数(不静默吞)。 */
  skipped: number;
  /** 达到安全上限被截断时为 true。 */
  truncated: boolean;
}

/**
 * 拉取某 registry 源的最新版本条目。
 * 请求固定带 version=latest:列表会混排同一 server 的多版本,客户端去重不可靠。
 */
export async function fetchRegistryEntries(
  baseUrl: string,
  opts: {
    fetcher?: RegistryJsonFetcher;
    signal?: AbortSignal;
    /** 连通性测试等场景可收窄分页上限。 */
    maxPages?: number;
    maxEntries?: number;
  } = {},
): Promise<RegistryListResult> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const maxPages = opts.maxPages ?? MCP_REGISTRY_MAX_PAGES;
  const maxEntries = opts.maxEntries ?? MCP_REGISTRY_MAX_ENTRIES;
  const all = new Map<string, RawRegistryServer>();
  let skipped = 0;
  let cursor: string | undefined;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    if (all.size >= maxEntries) { truncated = true; break; }

    const url = new URL(baseUrl);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    url.searchParams.set('version', 'latest');
    if (cursor) url.searchParams.set('cursor', cursor);

    const body = await fetcher(url.toString(), opts.signal);
    const parsedPage = parsePage(body);
    for (const item of parsedPage.servers) {
      const parsed = RawRegistryServerSchema.safeParse(item);
      if (!parsed.success) { skipped += 1; continue; }
      all.set(parsed.data.name, parsed.data);
    }

    cursor = parsedPage.nextCursor;
    if (!cursor) break;
    if (page === maxPages - 1) truncated = true;
  }

  return { entries: [...all.values()], skipped, truncated };
}

/**
 * 按条目名取最新版本(更新检查用);404 或解析失败返回 null。
 */
export async function fetchRegistryEntryLatest(
  baseUrl: string,
  entryName: string,
  opts: { fetcher?: RegistryJsonFetcher; signal?: AbortSignal } = {},
): Promise<RawRegistryServer | null> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const url = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(entryName)}/versions/latest`;
  try {
    const body = await fetcher(url, opts.signal);
    const server = unwrapServer(body);
    if (!server) return null;
    const parsed = RawRegistryServerSchema.safeParse(server);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parsePage(body: unknown): { servers: unknown[]; nextCursor?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { servers: [] };
  }
  const record = body as Record<string, unknown>;
  const servers = Array.isArray(record.servers) ? record.servers : [];
  const metadata = record.metadata;
  const nextCursor = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).nextCursor
    : undefined;
  return {
    servers: servers
      .map(unwrapServer)
      .filter((server): server is Record<string, unknown> => server !== null),
    nextCursor: typeof nextCursor === 'string' && nextCursor ? nextCursor : undefined,
  };
}

/** 列表项是 {server, _meta} 包裹形态;容忍直接展开的裸形态。 */
function unwrapServer(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const inner = record.server;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return record;
}
