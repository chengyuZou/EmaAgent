import { fetchJson } from '@ema-agent/marketplace';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { McpJsonIndex, McpJsonIndexConfig, McpJsonIndexEntry, McpMarketEntry } from './types.js';

// ── 通用 JSON 索引源(用户自传 URL)──────────────────────────────────────────────
//
// 约定 JSON 格式:{ entries: McpJsonIndexEntry[] }
// 用户可以自己 host 一个 MCP 列表(json-index),或镜像官方列表。
// transport 缺失时按 url/command 推断,保证宽松输入也能用。

function inferTransport(entry: McpJsonIndexEntry): 'stdio' | 'sse' | 'http' | null {
  if (entry.transport === 'stdio' || entry.transport === 'sse' || entry.transport === 'http') {
    return entry.transport;
  }
  if (entry.url) {
    return entry.url.toLowerCase().includes('/sse') ? 'sse' : 'http';
  }
  if (entry.command) return 'stdio';
  return null;
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
export async function listJsonIndexSource(
  source: MarketSourceRecord,
): Promise<McpMarketEntry[]> {
  const cfg = JSON.parse(source.config) as McpJsonIndexConfig;
  if (!cfg.indexUrl) throw new Error('json-index source missing indexUrl');

  const data = await fetchJson<McpJsonIndex>(cfg.indexUrl, cfg.mirrorUrl, {
    timeoutMs: 10_000,
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
