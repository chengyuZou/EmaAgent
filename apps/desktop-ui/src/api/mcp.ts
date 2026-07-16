/**
 * MCP API — MCP server management.
 */
import { sidecarClient } from './sidecar-client.js';
import type {
  McpServerConfig,
  McpServerRecord,
  McpConnection,
  McpToolInfo,
  McpProbeResult,
} from '@ema-agent/mcp';

export type { McpServerConfig, McpServerRecord, McpConnection, McpToolInfo, McpProbeResult };

export interface McpImportResult {
  name:          string;
  id?:           string;
  ok:            boolean;
  error?:        string;
  connectError?: string;
}

export interface McpMarketEntry {
  name:         string;
  title?:       string;
  description?: string;
  version?:     string;
  repository?:  string;
  websiteUrl?:  string;
  transport:    'stdio' | 'http' | null;
  url?:         string;
  command?:     string;
  args?:        string[];
}

export interface MarketSourceMeta {
  id:      string;
  label:   string;
  type:    string;
  error?:  string;
  count:   number;
}

export interface McpMarketResult {
  sources:  MarketSourceMeta[];
  servers:  McpMarketEntry[];
}

export const mcpApi = {
  /** GET /api/mcp/servers */
  async list(): Promise<{ servers: Array<McpServerRecord & { connection: McpConnection }> }> {
    return sidecarClient.request<{ servers: Array<McpServerRecord & { connection: McpConnection }> }>('/api/mcp/servers');
  },

  /** GET /api/mcp/servers/:name */
  async get(name: string): Promise<McpServerRecord & { connection: McpConnection }> {
    return sidecarClient.request<McpServerRecord & { connection: McpConnection }>(`/api/mcp/servers/${name}`);
  },

  /** POST /api/mcp/servers. `connect: false` saves without connecting (market installs). */
  async register(name: string, config: McpServerConfig, sourceUrl?: string, connect = true): Promise<{ id: string; connection: McpConnection }> {
    return sidecarClient.request<{ id: string; connection: McpConnection }>('/api/mcp/servers', {
      method: 'POST',
      json: { name, config, sourceUrl, connect },
    });
  },

  /** PUT /api/mcp/servers/:name/enable */
  async enable(name: string): Promise<{ ok: boolean }> {
    return sidecarClient.request<{ ok: boolean }>(`/api/mcp/servers/${name}/enable`, {
      method: 'PUT',
    });
  },

  /** PUT /api/mcp/servers/:name/disable */
  async disable(name: string): Promise<{ ok: boolean }> {
    return sidecarClient.request<{ ok: boolean }>(`/api/mcp/servers/${name}/disable`, {
      method: 'PUT',
    });
  },

  /** POST /api/mcp/servers/:name/connect */
  async connect(name: string): Promise<{ connection: McpConnection }> {
    return sidecarClient.request<{ connection: McpConnection }>(`/api/mcp/servers/${name}/connect`, {
      method: 'POST',
    });
  },

  /** POST /api/mcp/servers/:name/disconnect */
  async disconnect(name: string): Promise<{ ok: boolean }> {
    return sidecarClient.request<{ ok: boolean }>(`/api/mcp/servers/${name}/disconnect`, {
      method: 'POST',
    });
  },

  /** DELETE /api/mcp/servers/:name */
  async remove(name: string): Promise<{ ok: boolean }> {
    return sidecarClient.request<{ ok: boolean }>(`/api/mcp/servers/${name}`, {
      method: 'DELETE',
    });
  },

  /** POST /api/mcp/probe */
  async probe(serverName: string, config: McpServerConfig): Promise<McpProbeResult> {
    return sidecarClient.request<McpProbeResult>('/api/mcp/probe', {
      method: 'POST',
      json: { serverName, config },
    });
  },

  /** GET /api/mcp/market — 聚合所有 enabled 源,并发 fetch 合并。源管理走 /api/market/sources。 */
  async listMarket(): Promise<McpMarketResult> {
    return sidecarClient.request<McpMarketResult>('/api/mcp/market');
  },

  /**
   * POST /api/mcp/import — bulk-import servers from a Claude Desktop / mcp.so
   * JSON config. Accepts the raw object or a JSON string in `{ json }`.
   * Each entry is registered + best-effort connected; per-entry results returned.
   */
  async import(payload: object | string): Promise<{ imported: McpImportResult[] }> {
    return sidecarClient.request<{ imported: McpImportResult[] }>('/api/mcp/import', {
      method: 'POST',
      json:   { json: typeof payload === 'string' ? payload : JSON.stringify(payload) },
    });
  },
};
