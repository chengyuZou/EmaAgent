import type { MarketSourceAdapter } from '@ema-agent/marketplace';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { McpMarketEntry, McpRegistryConfig, McpJsonIndexConfig } from './types.js';
import { listMcpRegistrySource } from './mcp-registry.js';
import { listJsonIndexSource } from './json-index.js';

// ── MCP market adapter(kind='mcp')─────────────────────────────────────────────
//
// 支持 type:
//   - 'mcp-registry':官方 registry cursor 分页 API(config: { baseUrl, mirrorUrl? })
//   - 'json-index':  用户自传 JSON 索引(config: { indexUrl, mirrorUrl? })
// 新 type = 加一个 list*.ts + 在此 switch。

export class McpMarketAdapter implements MarketSourceAdapter<McpMarketEntry> {
  readonly kind  = 'mcp';
  readonly types = ['mcp-registry', 'json-index'] as const;

  async list(source: MarketSourceRecord): Promise<McpMarketEntry[]> {
    switch (source.type) {
      case 'mcp-registry': return listMcpRegistrySource(source);
      case 'json-index':   return listJsonIndexSource(source);
      default:
        throw new Error(`Unsupported mcp market source type: ${source.type}`);
    }
  }

  validateConfig(type: string, config: unknown): { ok: true; config: string } | { ok: false; error: string } {
    if (type === 'mcp-registry') {
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

    if (type === 'json-index') {
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

    return fail(`不支持的 mcp 源 type: ${type}`);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function ok(config: string): { ok: true; config: string } { return { ok: true, config }; }
function fail(error: string): { ok: false; error: string } { return { ok: false, error }; }
