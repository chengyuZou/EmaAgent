import type { MarketSourceRecord, MarketSourceTypeSchema } from '@ema-agent/marketplace';
import type { McpMarketEntry } from '../types.js';
import * as mcpRegistry from './mcp-registry.js';
import * as jsonIndex from './json-index.js';

// ── handlers 聚合(type → { list, validateConfig, schema } 映射)─────────────────
//
// 业务包内部约定:每个 source type 一个 handlers/<type>.ts,导出 list + validateConfig + schema。
// 此文件聚合 Map,adapter.ts 查表 dispatch + describeTypes 暴露 schema。加新 type = 加一个文件 + 在此注册。

export interface McpSourceTypeHandler {
  list:           (source: MarketSourceRecord) => Promise<McpMarketEntry[]>;
  validateConfig: (config: unknown) => { ok: true; config: string } | { ok: false; error: string };
  /** 该 type 的 config 表单 schema(前端动态渲染用) */
  schema:         MarketSourceTypeSchema;
}

export const MCP_TYPE_HANDLERS: Record<string, McpSourceTypeHandler> = {
  'mcp-registry': mcpRegistry,
  'json-index':   jsonIndex,
};

/** 该 kind 支持的所有 source type(供 adapter.ts 暴露给底座)。 */
export const MCP_SUPPORTED_TYPES = Object.keys(MCP_TYPE_HANDLERS);
