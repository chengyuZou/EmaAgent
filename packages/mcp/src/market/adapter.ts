import type { MarketSourceAdapter } from '@ema-agent/marketplace';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import type { McpMarketEntry } from './types.js';
import { MCP_TYPE_HANDLERS, MCP_SUPPORTED_TYPES } from './adapters/index.js';

// ── MCP market adapter(kind='mcp')─────────────────────────────────────────────
//
// 总 dispatch:查 adapters/ 的 type→handler Map,转发 list / validateConfig。
// 加新 source type = 加 adapters/<type>.ts + adapters/index.ts 注册一行,
// 此文件零改动。底座只见 MarketSourceAdapter 接口,不感知 type 细节。

export class McpMarketAdapter implements MarketSourceAdapter<McpMarketEntry> {
  readonly kind  = 'mcp';
  readonly types = MCP_SUPPORTED_TYPES;

  async list(source: MarketSourceRecord): Promise<McpMarketEntry[]> {
    const handler = MCP_TYPE_HANDLERS[source.type];
    if (!handler) throw new Error(`Unsupported mcp market source type: ${source.type}`);
    return handler.list(source);
  }

  validateConfig(type: string, config: unknown): { ok: true; config: string } | { ok: false; error: string } {
    const handler = MCP_TYPE_HANDLERS[type];
    if (!handler) return { ok: false, error: `不支持的 mcp 源 type: ${type}` };
    return handler.validateConfig(config);
  }
}
