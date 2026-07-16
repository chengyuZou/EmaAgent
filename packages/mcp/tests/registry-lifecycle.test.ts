// 这里测试 MCP 单 Server 连接复用、代际失效、失败重试和缓存工具保留。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig, McpToolInfo } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  openConnection: vi.fn(),
  discoverServerTools: vi.fn(),
  buildMcpBuiltTool: vi.fn((tool: McpToolInfo) => ({
    id: tool.qualifiedName,
    name: tool.qualifiedName,
  })),
}));

vi.mock('../src/connection.js', () => ({
  openConnection: mocks.openConnection,
}));

vi.mock('../src/discovery.js', () => ({
  discoverServerTools: mocks.discoverServerTools,
  buildMcpBuiltTool: mocks.buildMcpBuiltTool,
}));

import { McpRegistry } from '../src/registry.js';

const config: McpServerConfig = {
  type: 'http',
  url: 'https://example.com/mcp',
};

const tool: McpToolInfo = {
  serverToolName: 'search',
  qualifiedName: 'mcp__remote__search',
  originalServerName: 'remote',
  description: '搜索',
  inputSchema: { type: 'object' },
  reportedReadOnly: true,
  reportedDestructive: false,
};

function createHarness(cachedTools?: McpToolInfo[]) {
  const store = {
    findByName: vi.fn(() => ({ name: 'remote', config })),
    listEnabled: vi.fn(() => cachedTools ? [{ name: 'remote', config, cachedTools }] : []),
    cacheTools: vi.fn(),
  } as never;
  const toolRegistry = {
    registerMcpBatch: vi.fn(),
    unregisterMcp: vi.fn(),
  } as never;
  return {
    store,
    toolRegistry,
    registry: new McpRegistry(store, toolRegistry),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MCP Server 连接生命周期', () => {
  it('相同配置的并发连接共享一次打开和工具发现', async () => {
    const cleanup = vi.fn(async () => undefined);
    const discovery = deferred<McpToolInfo[]>();
    mocks.openConnection.mockResolvedValue({ client: {}, cleanup });
    mocks.discoverServerTools.mockReturnValue(discovery.promise);
    const { registry, toolRegistry } = createHarness();

    const first = registry.connectConfig('remote', config);
    const second = registry.connect('remote');
    await vi.waitFor(() => expect(mocks.discoverServerTools).toHaveBeenCalledTimes(1));

    expect(registry.getConnection('remote')).toMatchObject({ status: 'connecting' });
    discovery.resolve([tool]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'connected' }),
      expect.objectContaining({ status: 'connected' }),
    ]);
    expect(mocks.openConnection).toHaveBeenCalledTimes(1);
    expect(toolRegistry.registerMcpBatch).toHaveBeenCalledTimes(1);
  });

  it('连接中断开会使迟到任务失效并清理它打开的资源', async () => {
    const opened = deferred<{ client: object; cleanup: () => Promise<void> }>();
    const cleanup = vi.fn(async () => undefined);
    mocks.openConnection.mockReturnValue(opened.promise);
    const { registry, toolRegistry } = createHarness();

    const pending = registry.connectConfig('remote', config);
    await vi.waitFor(() => expect(mocks.openConnection).toHaveBeenCalledTimes(1));
    const lifecycleSignal = mocks.openConnection.mock.calls[0]?.[2] as AbortSignal;
    expect(lifecycleSignal.aborted).toBe(false);
    await registry.disconnect('remote');
    expect(lifecycleSignal.aborted).toBe(true);
    opened.resolve({ client: {}, cleanup });

    await expect(pending).rejects.toThrow(/superseded/i);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(toolRegistry.registerMcpBatch).not.toHaveBeenCalled();
    expect(registry.getConnection('remote')).toEqual({
      serverName: 'remote',
      status: 'disconnected',
      tools: [],
    });
  });

  it('连接失败公开失败原因，下一次调用可以重新连接', async () => {
    const cleanup = vi.fn(async () => undefined);
    mocks.openConnection.mockResolvedValue({ client: {}, cleanup });
    mocks.discoverServerTools
      .mockRejectedValueOnce(new Error('server offline'))
      .mockResolvedValueOnce([tool]);
    const { registry } = createHarness();

    await expect(registry.connectConfig('remote', config)).rejects.toThrow('server offline');
    expect(registry.getConnection('remote')).toMatchObject({
      status: 'failed',
      error: 'server offline',
    });

    await expect(registry.connectConfig('remote', config)).resolves.toMatchObject({
      status: 'connected',
      tools: [tool],
    });
    expect(mocks.openConnection).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('缓存工具在实时连接失败后仍保留在注册表和公开状态中', async () => {
    mocks.openConnection.mockRejectedValue(new Error('offline'));
    const { registry, toolRegistry } = createHarness([tool]);

    expect(registry.primeFromCache()).toBe(1);
    await expect(registry.connectConfig('remote', config)).rejects.toThrow('offline');

    expect(toolRegistry.registerMcpBatch).toHaveBeenCalledTimes(1);
    expect(toolRegistry.unregisterMcp).not.toHaveBeenCalled();
    expect(registry.getConnection('remote')).toMatchObject({
      status: 'failed',
      tools: [tool],
      error: 'offline',
    });
  });

  it('配置替换后旧连接即使迟到也不能覆盖新连接', async () => {
    const oldOpened = deferred<{ client: object; cleanup: () => Promise<void> }>();
    const oldCleanup = vi.fn(async () => undefined);
    const newCleanup = vi.fn(async () => undefined);
    const newConfig: McpServerConfig = {
      type: 'http',
      url: 'https://new.example.com/mcp',
    };
    mocks.openConnection.mockImplementation((_name: string, current: McpServerConfig) => (
      current.type === 'http' && current.url === config.url
        ? oldOpened.promise
        : Promise.resolve({ client: { generation: 'new' }, cleanup: newCleanup })
    ));
    mocks.discoverServerTools.mockResolvedValue([tool]);
    const { registry, toolRegistry } = createHarness();

    const oldTask = registry.connectConfig('remote', config);
    await vi.waitFor(() => expect(mocks.openConnection).toHaveBeenCalledTimes(1));
    const oldSignal = mocks.openConnection.mock.calls[0]?.[2] as AbortSignal;
    await expect(registry.connectConfig('remote', newConfig)).resolves.toMatchObject({
      status: 'connected',
    });
    expect(oldSignal.aborted).toBe(true);

    oldOpened.resolve({ client: { generation: 'old' }, cleanup: oldCleanup });
    await expect(oldTask).rejects.toThrow(/superseded/i);

    expect(oldCleanup).toHaveBeenCalledTimes(1);
    expect(newCleanup).not.toHaveBeenCalled();
    expect(toolRegistry.registerMcpBatch).toHaveBeenCalledTimes(1);
    expect(registry.getConnection('remote')).toMatchObject({ status: 'connected' });
  });
});
