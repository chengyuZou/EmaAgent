// 测试 MCP Transport 意外关闭后状态失败、缓存工具保留和下一次连接恢复。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolRegistry } from '@ema-agent/tools';
import type { McpServerStore } from '../store.js';
import type { McpServerRecord } from '../types.js';

const connection = vi.hoisted(() => ({
  openConnection: vi.fn(),
}));

vi.mock('../connection.js', () => ({
  openConnection: connection.openConnection,
}));

import { McpRegistry } from '../registry.js';

interface FakeClient extends Client {
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

function server(config: McpServerRecord['config'] = { type: 'stdio', command: 'mock-mcp-server', args: [] }): McpServerRecord {
  return {
    id: 'server-local',
    name: 'local',
    provenance: { sourceKind: 'manual' },
    config,
    enabled: true,
  };
}

function openedConnection() {
  const client = {
    listTools: vi.fn(async () => ({
      tools: [{
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object' },
      }],
    })),
    setNotificationHandler: vi.fn(),
    callTool: vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
    })),
    close: vi.fn(async () => undefined),
  } as unknown as FakeClient;
  return {
    client,
    cleanup: vi.fn(async () => {
      client.onclose?.();
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => vi.useRealTimers());

describe('McpRegistry 连接生命周期', () => {
  it('Transport 意外关闭后标记 failed，并在下一次调用时惰性重连', async () => {
    const first = openedConnection();
    const second = openedConnection();
    connection.openConnection
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const store = {
      findByName: vi.fn(() => server()),
      cacheTools: vi.fn(),
    } as unknown as McpServerStore;
    const toolRegistry = new ToolRegistry();
    const registry = new McpRegistry(store, toolRegistry);

    await expect(registry.connect('local')).resolves.toMatchObject({
      status: 'connected',
    });
    expect(toolRegistry.has('mcp__local__search')).toBe(true);

    const crash = new Error('stdio child exited');
    first.client.onerror?.(crash);
    first.client.onclose?.();

    expect(registry.getConnection('local')).toMatchObject({
      status: 'failed',
      error: 'stdio child exited',
      tools: [expect.objectContaining({ serverToolName: 'search' })],
    });
    expect(toolRegistry.has('mcp__local__search')).toBe(false);

    await expect(registry.callTool('local', 'search', {})).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(registry.getConnection('local')).toMatchObject({ status: 'connected' });
    expect(connection.openConnection).toHaveBeenCalledTimes(2);
  });

  it('显式断开触发的 onclose 不得把 disconnected 改成 failed', async () => {
    const opened = openedConnection();
    connection.openConnection.mockResolvedValueOnce(opened);
    const store = {
      findByName: vi.fn(() => server()),
      cacheTools: vi.fn(),
    } as unknown as McpServerStore;
    const registry = new McpRegistry(store, new ToolRegistry());

    await registry.connect('local');
    await registry.disconnect('local');

    expect(registry.getConnection('local')).toMatchObject({
      status: 'disconnected',
      tools: [],
    });
  });

  it('HTTP 连接意外关闭后按 1/2/4/8/16 秒重试五次', async () => {
    vi.useFakeTimers();
    const first = openedConnection();
    connection.openConnection.mockResolvedValueOnce(first);
    connection.openConnection.mockRejectedValue(new Error('remote unavailable'));
    const record = server({ type: 'http', url: 'https://example.com/mcp' });
    const store = {
      findByName: vi.fn(() => record),
      cacheTools: vi.fn(),
    } as unknown as McpServerStore;
    const registry = new McpRegistry(store, new ToolRegistry());

    await registry.connect('local');
    first.client.onclose?.();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(connection.openConnection).toHaveBeenCalledTimes(6);
    expect(registry.getConnection('local')).toMatchObject({ status: 'failed' });
  });
});
