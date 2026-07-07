import { fetchJson } from '@ema-agent/marketplace';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { McpMarketEntry, McpRegistryConfig } from '../types.js';

// ── mcp-registry source type ──────────────────────────────────────────────────
//
// 官方 MCP registry cursor 分页 API。从 apps/core/src/routes/mcp.ts:33-154 搬来。
// registry.modelcontextprotocol.io 的 REST API,cursor 分页无总数,跟 nextCursor 直到取完(有安全 cap)。

const MCP_REGISTRY_CAP   = 600;  // 单源总条目安全 cap
const MCP_REGISTRY_PAGES = 12;   // cursor follow-up 次数 cap

// registry 用 snake_case,部分 key 在新版改了名,防御性接受两种拼写。
interface RegistryPackage {
  registry_type?: string;   // "npm" | "pypi" | "oci" …
  registry_name?: string;   // 旧字段名
  identifier?:    string;
  name?:          string;
  version?:       string;
  runtime_hint?:  string;
  transport?:     { type?: string };
}
interface RegistryRemote { type?: string; url?: string }
interface RegistryServer {
  name:         string;
  title?:       string;
  description?: string;
  version?:     string;
  websiteUrl?:  string;
  repository?:  { url?: string };
  remotes?:     RegistryRemote[];
  packages?:    RegistryPackage[];
}
// 每个 list item 把 server 包在 `server` 下,registry metadata 在 `_meta`。
interface RegistryItem { server?: RegistryServer }

function normaliseRegistryServer(s: RegistryServer): McpMarketEntry {
  const base: McpMarketEntry = {
    name:        s.name,
    title:       s.title,
    description: s.description,
    version:     s.version,
    repository:  s.repository?.url,
    websiteUrl:  s.websiteUrl,
    transport:   null,
  };

  // 优先 hosted remote(无需本地安装)
  const remote = s.remotes?.find((r) => r.url);
  if (remote?.url) {
    return { ...base, transport: remote.type === 'sse' ? 'sse' : 'http', url: remote.url };
  }

  // 否则从第一个 package 推 stdio 启动命令
  const pkg = s.packages?.find((p) => p.identifier || p.name);
  const pkgId = pkg?.identifier ?? pkg?.name;
  if (pkg && pkgId) {
    const kind = pkg.registry_type ?? pkg.registry_name;
    if (kind === 'npm') {
      return { ...base, transport: 'stdio', command: 'npx', args: ['-y', pkgId] };
    }
    if (kind === 'pypi') {
      return { ...base, transport: 'stdio', command: 'uvx', args: [pkgId] };
    }
  }
  return base;
}

/** 列出某 mcp-registry 源的所有可装 server(去重 by name,留最新版本)。 */
export async function list(source: MarketSourceRecord): Promise<McpMarketEntry[]> {
  const cfg = JSON.parse(source.config) as McpRegistryConfig;
  if (!cfg.baseUrl) throw new Error('mcp-registry source missing baseUrl');

  const all = new Map<string, McpMarketEntry>();
  let cursor: string | undefined;

  for (let page = 0; page < MCP_REGISTRY_PAGES && all.size < MCP_REGISTRY_CAP; page++) {
    const url = new URL(cfg.baseUrl);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const body = await fetchJson<{
      servers?:  Array<RegistryItem | RegistryServer>;
      metadata?: { nextCursor?: string };
    }>(url.toString(), cfg.mirrorUrl, {
      timeoutMs: 10_000,
      headers:   { Accept: 'application/json' },
    });

    for (const item of body.servers ?? []) {
      const s = 'server' in item && item.server ? item.server : (item as RegistryServer);
      if (!s || typeof s.name !== 'string') continue;
      const entry = normaliseRegistryServer(s);
      if (entry.transport === null) continue;  // 无 transport 的条目跳过
      all.set(entry.name, entry);  // 后者(新版本)覆盖
    }

    cursor = body.metadata?.nextCursor;
    if (!cursor) break;
  }
  return [...all.values()];
}

/** 校验 mcp-registry config,返回标准化 JSON。 */
export function validateConfig(config: unknown): { ok: true; config: string } | { ok: false; error: string } {
  if (!isObj(config)) return fail('config 必须是对象');
  const baseUrl = (config as { baseUrl?: unknown }).baseUrl;
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('http')) return fail('baseUrl 必须是 http(s) URL');
  const mirrorUrl = (config as { mirrorUrl?: unknown }).mirrorUrl;
  if (mirrorUrl !== undefined && (typeof mirrorUrl !== 'string' || !mirrorUrl.startsWith('http'))) {
    return fail('mirrorUrl 必须是 http(s) URL');
  }
  const cfg: McpRegistryConfig = { baseUrl, ...(typeof mirrorUrl === 'string' ? { mirrorUrl } : {}) };
  return ok(JSON.stringify(cfg));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function ok(config: string): { ok: true; config: string } { return { ok: true, config }; }
function fail(error: string): { ok: false; error: string } { return { ok: false, error }; }
