// 测试 MCP 启动发现只补齐无缓存 Schema，并以确定顺序注册而不保留连接。

import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@ema-agent/tools';
import { McpRegistry } from '../registry.js';
import type {
  McpServerRecord,
  McpToolInfo,
} from '../types.js';
import type { McpServerStore } from '../store.js';

function server(name: string, cachedTools?: McpToolInfo[]): McpServerRecord {
  return {
    id: `server-${name}`,
    name,
    provenance: { sourceKind: 'manual' },
    config: { type: 'http', url: `https://${name}.example.com/mcp` },
    cachedTools,
    cachedAt: cachedTools ? 1 : 0,
    enabled: true,
    installedAt: 1,
  };
}

function tool(serverName: string, toolName: string): McpToolInfo {
  return {
    serverToolName: toolName,
    qualifiedName: `mcp__${serverName}__${toolName}`,
    originalServerName: serverName,
    description: toolName,
    inputSchema: { type: 'object' },
    reportedReadOnly: false,
    reportedDestructive: false,
  };
}

describe('McpRegistry 启动发现', () => {
  it('跳过已有缓存并按服务器与工具名称稳定注册', async () => {
    const cacheTools = vi.fn();
    const store = {
      listEnabled: vi.fn(() => [
        server('zeta'),
        server('cached', [tool('cached', 'ready')]),
        server('alpha'),
      ]),
      cacheTools,
    } as unknown as McpServerStore;
    const tools = new ToolRegistry();
    const registry = new McpRegistry(store, tools);
    const probe = vi.spyOn(registry, 'probe');
    probe.mockImplementation(async (serverName) => ({
      ok: true,
      tools: serverName === 'alpha'
        ? [tool('alpha', 'z'), tool('alpha', 'a')]
        : [tool('zeta', 'b')],
    }));

    await expect(registry.discoverUncached()).resolves.toBe(3);

    expect(probe.mock.calls.map(([name]) => name).sort()).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(tools.list().map((entry) => entry.name)).toEqual([
      'mcp__alpha__a',
      'mcp__alpha__z',
      'mcp__zeta__b',
    ]);
    expect(cacheTools.mock.calls.map(([name]) => name)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(registry.getAllConnections()).toEqual([
      expect.objectContaining({
        serverName: 'alpha',
        status: 'disconnected',
      }),
      expect.objectContaining({
        serverName: 'zeta',
        status: 'disconnected',
      }),
    ]);
  });
});
