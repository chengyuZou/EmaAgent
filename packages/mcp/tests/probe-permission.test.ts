// 这里测试 MCP 本地进程的权限门禁、禁用开关、超时和连接清理。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpStdioLaunchIntent, McpToolInfo } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  openConnection: vi.fn(),
  discoverServerTools: vi.fn(),
}));

vi.mock('../src/connection.js', () => ({
  openConnection: mocks.openConnection,
}));

vi.mock('../src/discovery.js', () => ({
  discoverServerTools: mocks.discoverServerTools,
  buildMcpBuiltTool: vi.fn(),
}));

import { McpRegistry } from '../src/registry.js';

const store = {
  findByName: vi.fn(),
  listEnabled: vi.fn(() => []),
} as never;

const toolRegistry = {
  registerMcpBatch: vi.fn(),
  unregisterMcp: vi.fn(),
} as never;

const discoveredTool: McpToolInfo = {
  serverToolName: 'search',
  qualifiedName: 'mcp__test__search',
  originalServerName: 'test',
  description: '搜索',
  inputSchema: { type: 'object' },
  isReadOnly: true,
  isDestructive: false,
};

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('MCP Probe stdio 权限与资源边界', () => {
  it('全局禁用 stdio 时不询问权限也不启动本地进程', async () => {
    const gate = vi.fn(async () => true);
    const registry = new McpRegistry(store, toolRegistry, gate, false);

    const result = await registry.probe('disabled-local', {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
    });

    expect(result.ok).toBe(false);
    expect(gate).not.toHaveBeenCalled();
    expect(mocks.openConnection).not.toHaveBeenCalled();
  });

  it('权限拒绝时绝不启动 stdio 子进程，并提交完整启动意图', async () => {
    let observed: McpStdioLaunchIntent | undefined;
    const gate = vi.fn(async (intent: McpStdioLaunchIntent) => {
      observed = intent;
      return false;
    });
    const registry = new McpRegistry(store, toolRegistry, gate);

    const result = await registry.probe('local-search', {
      type: 'stdio',
      command: 'node',
      args: ['server.js', '--mode', 'read-only'],
      cwd: 'D:/workspace',
      env: { API_TOKEN: 'secret' },
    });

    expect(result).toMatchObject({ ok: false, tools: [] });
    expect(mocks.openConnection).not.toHaveBeenCalled();
    expect(observed).toMatchObject({
      operation: 'probe',
      serverName: 'local-search',
      command: 'node',
      args: ['server.js', '--mode', 'read-only'],
      cwd: 'D:/workspace',
      environment: { API_TOKEN: 'secret' },
    });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed?.args)).toBe(true);
    expect(Object.isFrozen(observed?.environment)).toBe(true);
  });

  it('正式连接在工具发现失败时也会清理且不暴露半连接状态', async () => {
    const cleanup = vi.fn(async () => undefined);
    mocks.openConnection.mockResolvedValue({ client: {}, cleanup });
    mocks.discoverServerTools.mockRejectedValue(new Error('connect discovery failed'));
    const registry = new McpRegistry(store, toolRegistry);

    await expect(registry.connectConfig('remote-connect', {
      type: 'http',
      url: 'https://example.com/mcp',
    })).rejects.toThrow('connect discovery failed');

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.getConnection('remote-connect')).toBeNull();
  });

  it('没有权限 Gate 时 stdio Probe 默认拒绝', async () => {
    const registry = new McpRegistry(store, toolRegistry);
    const result = await registry.probe('no-gate', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'some-package'],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no permission gate/i);
    expect(mocks.openConnection).not.toHaveBeenCalled();
  });

  it('HTTP Probe 不触发 stdio Gate，并返回完整工具结构', async () => {
    const cleanup = vi.fn(async () => undefined);
    mocks.openConnection.mockResolvedValue({ client: {}, cleanup });
    mocks.discoverServerTools.mockResolvedValue([discoveredTool]);
    const gate = vi.fn(async () => false);
    const registry = new McpRegistry(store, toolRegistry, gate);

    const result = await registry.probe('remote-search', {
      type: 'http',
      url: 'https://example.com/mcp',
    });

    expect(result).toEqual({ ok: true, tools: [discoveredTool] });
    expect(gate).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('审批期间修改原配置不会改变实际启动参数', async () => {
    const rawArgs = ['server.js'];
    const cleanup = vi.fn(async () => undefined);
    mocks.openConnection.mockResolvedValue({ client: {}, cleanup });
    mocks.discoverServerTools.mockResolvedValue([]);
    const gate = vi.fn(async () => {
      rawArgs.push('changed-after-approval');
      return true;
    });
    const registry = new McpRegistry(store, toolRegistry, gate);

    const result = await registry.probe('immutable', {
      type: 'stdio',
      command: 'node',
      args: rawArgs,
    });

    expect(result.ok).toBe(true);
    const openedConfig = mocks.openConnection.mock.calls[0]?.[1];
    expect(openedConfig.args).toEqual(['server.js']);
    expect(Object.isFrozen(openedConfig)).toBe(true);
    expect(Object.isFrozen(openedConfig.args)).toBe(true);
  });

  it('工具发现异常时仍然清理已经打开的连接', async () => {
    const cleanup = vi.fn(async () => undefined);
    mocks.openConnection.mockResolvedValue({ client: {}, cleanup });
    mocks.discoverServerTools.mockRejectedValue(new Error('discovery failed'));
    const registry = new McpRegistry(store, toolRegistry, vi.fn(async () => true));

    const result = await registry.probe('cleanup-on-error', {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
    });

    expect(result).toEqual({ ok: false, tools: [], error: 'discovery failed' });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('工具发现超时后清理连接', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => undefined);
    mocks.openConnection.mockResolvedValue({ client: {}, cleanup });
    mocks.discoverServerTools.mockReturnValue(new Promise(() => undefined));
    const registry = new McpRegistry(store, toolRegistry);

    const pending = registry.probe('timeout', {
      type: 'http',
      url: 'https://example.com/mcp',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
