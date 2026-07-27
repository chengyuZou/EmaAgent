// 这里分页读取 MCP Registry, 并转换为可以安装或连接的 MCP 市场条目.
import { fetchJson } from '@ema-agent/marketplace';
import type { MarketSourceRecord, MarketSourceTypeSchema } from '@ema-agent/marketplace';
import type { McpMarketEntry, McpRegistryConfig } from '../types.js';
import { buildLockedPackageLaunch } from '../package-spec.js';

// ── mcp-registry source type ──────────────────────────────────────────────────
//
// 官方 MCP registry cursor 分页 API。从 apps/localHost/src/routes/mcp.ts:33-154 搬来。
// registry.modelcontextprotocol.io 的 REST API,cursor 分页无总数,跟 nextCursor 直到取完(有安全 cap)。

const MCP_REGISTRY_CAP   = 600;  // 单源总条目安全 cap
const MCP_REGISTRY_PAGES = 12;   // cursor follow-up 次数 cap

// registry 用 snake_case,部分 key 在新版改了名,防御性接受两种拼写。
interface RegistryPackage {
  registryType?:  string;   // 当前官方 server.json 字段
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
    installable: false,
  };

  // 优先 hosted remote(无需本地安装)
  const remote = s.remotes?.find((r) => r.url && r.type !== 'sse');
  if (remote?.url) {
    return { ...base, transport: 'http', url: remote.url, installable: true };
  }

  // 一个条目可能同时提供多种包格式，优先选择能够精确锁定的 npm 或 PyPI 包。
  const packages = s.packages ?? [];
  for (const pkg of packages) {
    const pkgId = pkg.identifier ?? pkg.name;
    if (!pkgId) continue;
    const kind = pkg.registryType ?? pkg.registry_type ?? pkg.registry_name;
    const launch = buildLockedPackageLaunch(kind, pkgId, pkg.version);
    if (launch) {
      return {
        ...base,
        transport: 'stdio',
        installable: true,
        command: launch.command,
        args: launch.args,
        packageRegistry: launch.registry,
        packageName: launch.packageName,
        packageVersion: launch.packageVersion,
      };
    }
  }
  if (packages.some((pkg) => pkg.identifier || pkg.name)) {
    return {
      ...base,
      transport: 'stdio',
      installable: false,
      unavailableReason: '包缺少受支持的 registry、合法包名或精确版本，已阻止未锁定安装',
    };
  }
  return base;
}

/** 列出某 mcp-registry 源的所有可装 server(去重 by name,留最新版本)。 */
export async function list(source: MarketSourceRecord, signal?: AbortSignal): Promise<McpMarketEntry[]> {
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
      signal,
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

/** 该 type 的 config 表单 schema(供前端"添加源"Dialog 动态渲染)。 */
export const schema: MarketSourceTypeSchema = {
  type:   'mcp-registry',
  label:  'MCP 官方 Registry(cursor 分页)',
  fields: [
    { key: 'baseUrl',    label: 'Base URL',            placeholder: 'https://registry.modelcontextprotocol.io/v0/servers', required: true },
    { key: 'mirrorUrl',  label: '镜像 URL(可选,失败降级)', placeholder: 'https://...', optional: true },
  ],
};

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function ok(config: string): { ok: true; config: string } { return { ok: true, config }; }
function fail(error: string): { ok: false; error: string } { return { ok: false, error }; }
