// 测试 MCP 管理路由的连接态合并、注册免连接和探测失败映射。

import { describe, expect, it, vi } from 'vitest';
import type { McpConnection, McpServerRecord } from '@ema-agent/mcp';
import { createMcpRouter } from '../src/routes/mcp.js';

type McpRegistryArg = Parameters<typeof createMcpRouter>[0];
type MarketSourcesArg = Parameters<typeof createMcpRouter>[1];
type MarketRegistryArg = Parameters<typeof createMcpRouter>[2];

function record(name: string): McpServerRecord {
  return {
    id: `id-${name}`,
    name,
    provenance: { sourceKind: 'manual' },
    config: { type: 'http', url: 'https://example.com/mcp' },
    cachedAt: 0,
    enabled: true,
    installedAt: 1,
  };
}

function connection(name: string, status: McpConnection['status']): McpConnection {
  return { serverName: name, status, tools: [] };
}

function createApp(overrides: Partial<McpRegistryArg> = {}) {
  const mcpRegistry: McpRegistryArg = {
    listRecords: vi.fn(() => []),
    getAllConnections: vi.fn(() => []),
    register: vi.fn(() => 'new-id'),
    connectConfig: vi.fn(async () => connection('srv', 'connected')),
    getConnection: vi.fn(() => null),
    setEnabled: vi.fn(),
    connect: vi.fn(async () => connection('srv', 'connected')),
    disconnect: vi.fn(async () => {}),
    remove: vi.fn(),
    probe: vi.fn(async () => ({ ok: true, tools: [] })),
    ...overrides,
  };
  const marketSources: MarketSourcesArg = { listEnabled: vi.fn(() => []) };
  const marketRegistry: MarketRegistryArg = { listAll: vi.fn(async () => []) };
  const app = createMcpRouter(mcpRegistry, marketSources, marketRegistry);
  return { app, mcpRegistry };
}

describe('MCP 管理路由', () => {
  it('GET /servers 合并连接状态，未连接的服务器使用明确缺省', async () => {
    const { app } = createApp({
      listRecords: vi.fn(() => [record('online'), record('offline')]),
      getAllConnections: vi.fn(() => [connection('online', 'connected')]),
    });

    const response = await app.request('/servers');

    expect(response.status).toBe(200);
    const body = await response.json() as {
      servers: Array<{ name: string; connection: McpConnection }>;
    };
    expect(body.servers).toHaveLength(2);
    expect(body.servers[0]!.connection.status).toBe('connected');
    expect(body.servers[1]!.connection).toEqual({
      serverName: 'offline',
      status: 'disconnected',
      tools: [],
    });
  });

  it('POST /servers connect:false 只登记不发起连接', async () => {
    const { app, mcpRegistry } = createApp();

    const response = await app.request('/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'srv',
        config: { type: 'http', url: 'https://example.com/mcp' },
        connect: false,
      }),
    });

    expect(response.status).toBe(201);
    expect(mcpRegistry.register).toHaveBeenCalledOnce();
    expect(mcpRegistry.connectConfig).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      connection: { serverName: 'srv', status: 'disconnected' },
    });
  });

  it('POST /servers 登记成功但连接失败时仍返回 201 并携带错误', async () => {
    const { app } = createApp({
      connectConfig: vi.fn(async () => {
        throw new Error('连接超时');
      }),
    });

    const response = await app.request('/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'srv',
        config: { type: 'http', url: 'https://example.com/mcp' },
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: 'new-id',
      error: expect.stringContaining('连接超时'),
    });
  });

  it('POST /probe 失败结果映射为 500', async () => {
    const { app } = createApp({
      probe: vi.fn(async () => ({ ok: false, tools: [], error: '拒绝连接' })),
    });

    const response = await app.request('/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverName: 'srv',
        config: { type: 'http', url: 'https://example.com/mcp' },
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
