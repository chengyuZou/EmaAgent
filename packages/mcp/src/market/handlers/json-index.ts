// 这里读取用户配置的 JSON 索引并转换为 MCP 市场条目.
import { fetchJson } from '@ema-agent/marketplace';
import type { MarketSourceRecord, MarketSourceTypeSchema } from '@ema-agent/marketplace';
import type { McpJsonIndex, McpJsonIndexConfig, McpJsonIndexEntry, McpMarketEntry } from '../types.js';

// ── json-index source type ────────────────────────────────────────────────────
//
// 通用 JSON 索引源(用户自传 URL)。约定 JSON 格式:{ entries: McpJsonIndexEntry[] }
// 用户可自 host 一个 MCP 列表(json-index),或镜像官方列表。
// transport 缺失时按 url/command 推断,保证宽松输入也能用。

function inferTransport(entry: McpJsonIndexEntry): 'stdio' | 'http' | null {
  const reportedTransport = (entry as { transport?: unknown }).transport;
  if (reportedTransport === 'sse') return null;
  if (reportedTransport === 'stdio' || reportedTransport === 'http') {
    return reportedTransport;
  }
  if (entry.url) {
    return looksLikeLegacySseEndpoint(entry.url) ? null : 'http';
  }
  if (entry.command) return 'stdio';
  return null;
}

function looksLikeLegacySseEndpoint(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.replace(/\/+$/, '').toLowerCase();
    return pathname.endsWith('/sse');
  } catch {
    return false;
  }
}

function toMarketEntry(raw: McpJsonIndexEntry): McpMarketEntry | null {
  if (!raw.name) return null;
  const transport = inferTransport(raw);
  if (transport === null) return null;
  return {
    name:        raw.name,
    title:       raw.title,
    description: raw.description,
    version:     raw.version,
    repository:  raw.repository,
    websiteUrl:  raw.websiteUrl,
    transport,
    url:         raw.url,
    command:     raw.command,
    args:        raw.args,
  };
}

/** 列出某 json-index 源的所有可装 server。 */
export async function list(source: MarketSourceRecord, signal?: AbortSignal): Promise<McpMarketEntry[]> {
  const cfg = JSON.parse(source.config) as McpJsonIndexConfig;
  if (!cfg.indexUrl) throw new Error('json-index source missing indexUrl');

  const data = await fetchJson<McpJsonIndex>(cfg.indexUrl, cfg.mirrorUrl, {
    timeoutMs: 10_000,
    signal,
    headers:   { Accept: 'application/json' },
  });

  const entries = (data?.entries ?? [])
    .map(toMarketEntry)
    .filter((e): e is McpMarketEntry => e !== null);

  // 按 name 去重,留最后一条
  const map = new Map<string, McpMarketEntry>();
  for (const e of entries) map.set(e.name, e);
  return [...map.values()];
}

/** 校验 json-index config,返回标准化 JSON。 */
export function validateConfig(config: unknown): { ok: true; config: string } | { ok: false; error: string } {
  if (!isObj(config)) return fail('config 必须是对象');
  const indexUrl = (config as { indexUrl?: unknown }).indexUrl;
  if (typeof indexUrl !== 'string' || !indexUrl.startsWith('http')) return fail('indexUrl 必须是 http(s) URL');
  const mirrorUrl = (config as { mirrorUrl?: unknown }).mirrorUrl;
  if (mirrorUrl !== undefined && (typeof mirrorUrl !== 'string' || !mirrorUrl.startsWith('http'))) {
    return fail('mirrorUrl 必须是 http(s) URL');
  }
  const cfg: McpJsonIndexConfig = { indexUrl, ...(typeof mirrorUrl === 'string' ? { mirrorUrl } : {}) };
  return ok(JSON.stringify(cfg));
}

/** 该 type 的 config 表单 schema(供前端"添加源"Dialog 动态渲染)。 */
export const schema: MarketSourceTypeSchema = {
  type:   'json-index',
  label:  'JSON 索引(用户自传 URL)',
  fields: [
    { key: 'indexUrl',   label: '索引 URL',       placeholder: 'https://my-server.com/mcp-list.json', required: true },
    { key: 'mirrorUrl',  label: '镜像 URL(可选)', placeholder: 'https://...', optional: true },
  ],
};

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function ok(config: string): { ok: true; config: string } { return { ok: true, config }; }
function fail(error: string): { ok: false; error: string } { return { ok: false, error }; }
