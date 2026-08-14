// 测试 MCP 管理路由的连接态合并、注册免连接、探测失败映射与 Registry 源 CRUD。

import { describe, expect, it, vi } from 'vitest';
import type { McpConnection, McpRegistrySource, McpServerRecord } from '@ema-agent/mcp';
import { createMcpRouter } from '../src/routes/mcp.js';

type McpRegistryArg = Parameters<typeof createMcpRouter>[0];
type McpSourcesArg = Parameters<typeof createMcpRouter>[1];

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

function source(id: string, builtin = false): McpRegistrySource {
  return {
    id,
    label: id,
    registryUrl: 'https://registry.example/v0/servers',
    enabled: true,
    builtin,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createApp(
  overrides: Partial<McpRegistryArg> = {},
  sourceOverrides: Partial<McpSourcesArg> = {},
) {
  const mcpRegistry: McpRegistryArg = {
    listRecords: vi.fn(() => []),
    getAllConnections: vi.fn(() => []),
    register: vi.fn(() => 'new-id'),
    findByName: vi.fn(() => null),
    connectConfig: vi.fn(async () => connection('srv', 'connected')),
    getConnection: vi.fn(() => null),
    setEnabled: vi.fn(),
    connect: vi.fn(async () => connection('srv', 'connected')),
    disconnect: vi.fn(async () => {}),
    remove: vi.fn(),
    probe: vi.fn(async () => ({ ok: true, tools: [] })),
    ...overrides,
  };
  const mcpSources: McpSourcesArg = {
    list: vi.fn(() => []),
    listEnabled: vi.fn(() => []),
    get: vi.fn(() => null),
    add: vi.fn((label: string, registryUrl: string) => ({
      ...source('new-source'), label, registryUrl,
    })),
    update: vi.fn(),
    remove: vi.fn(() => true),
    ...sourceOverrides,
  };
  const app = createMcpRouter(mcpRegistry, mcpSources);
  return { app, mcpRegistry, mcpSources };
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

  it('GET /registry-sources 返回源列表;DELETE 内置源被 404 拒绝', async () => {
    const { app } = createApp({}, {
      list: vi.fn(() => [source('official-mcp-registry', true)]),
      remove: vi.fn(() => false),   // repo 层 builtin 保护
    });

    const listResponse = await app.request('/registry-sources');
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      sources: [{ id: 'official-mcp-registry', builtin: true }],
    });

    const deleteResponse = await app.request('/registry-sources/official-mcp-registry', {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(404);
  });
});
