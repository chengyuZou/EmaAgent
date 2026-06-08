/**
 * MCP API — MCP server management.
 */
import { sidecarClient } from './sidecar-client.js';
import type { McpServerConfig, McpServerRecord, McpConnection, McpToolInfo } from '@ema-agent/mcp';

export type { McpServerConfig, McpServerRecord, McpConnection, McpToolInfo };

export interface McpProbeResult {
  ok:      boolean;
  error?:  string;
  tools?:  McpToolInfo[];
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

  /** POST /api/mcp/servers */
  async register(name: string, config: McpServerConfig, sourceUrl?: string): Promise<{ id: string; connection: McpConnection }> {
    return sidecarClient.request<{ id: string; connection: McpConnection }>('/api/mcp/servers', {
      method: 'POST',
      json: { name, config, sourceUrl },
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
  async probe(config: McpServerConfig): Promise<McpProbeResult> {
    return sidecarClient.request<McpProbeResult>('/api/mcp/probe', {
      method: 'POST',
      json: config,
    });
  },
};
