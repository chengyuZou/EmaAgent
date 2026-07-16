// 这里测试 MCP 单 Server 连接复用、代际失效、失败重试和缓存工具保留。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function clientStub() {
  return { setNotificationHandler: vi.fn() };
}

function createHarness(cachedTools?: McpToolInfo[]) {
  const store = {
    findByName: vi.fn(() => ({ name: 'remote', config })),
    listEnabled: vi.fn(() => cachedTools ? [{ name: 'remote', config, cachedTools }] : []),
    cacheTools: vi.fn(),
  };
  const toolRegistry = {
    registerMcpBatch: vi.fn(),
    unregisterMcp: vi.fn(),
  };
  return {
    store,
    toolRegistry,
    registry: new McpRegistry(store as never, toolRegistry as never),
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MCP Server 连接生命周期', () => {
  it('相同配置的并发连接共享一次打开和工具发现', async () => {
    const cleanup = vi.fn(async () => undefined);
    const discovery = deferred<McpToolInfo[]>();
    mocks.openConnection.mockResolvedValue({ client: clientStub(), cleanup });
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
    opened.resolve({ client: clientStub(), cleanup });

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
    mocks.openConnection.mockResolvedValue({ client: clientStub(), cleanup });
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
        : Promise.resolve({ client: { generation: 'new', ...clientStub() }, cleanup: newCleanup })
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

    oldOpened.resolve({ client: { generation: 'old', ...clientStub() }, cleanup: oldCleanup });
    await expect(oldTask).rejects.toThrow(/superseded/i);

    expect(oldCleanup).toHaveBeenCalledTimes(1);
    expect(newCleanup).not.toHaveBeenCalled();
    expect(toolRegistry.registerMcpBatch).toHaveBeenCalledTimes(1);
    expect(registry.getConnection('remote')).toMatchObject({ status: 'connected' });
  });

  it('收到 tools/list_changed 后原子替换工具并更新缓存', async () => {
    const nextTool: McpToolInfo = {
      ...tool,
      serverToolName: 'browse',
      qualifiedName: 'mcp__remote__browse',
      description: '浏览',
    };
    let notificationHandler: (() => void | Promise<void>) | undefined;
    const client = {
      setNotificationHandler: vi.fn((_schema: unknown, handler: () => void | Promise<void>) => {
        notificationHandler = handler;
      }),
    };
    mocks.openConnection.mockResolvedValue({
      client,
      cleanup: vi.fn(async () => undefined),
    });
    mocks.discoverServerTools
      .mockResolvedValueOnce([tool])
      .mockResolvedValueOnce([nextTool]);
    const { registry, store, toolRegistry } = createHarness();

    await registry.connectConfig('remote', config);
    expect(notificationHandler).toBeTypeOf('function');
    await notificationHandler?.();
    await vi.waitFor(() => expect(mocks.discoverServerTools).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(registry.getTools('remote')).toEqual([nextTool]));

    expect(toolRegistry.registerMcpBatch).toHaveBeenCalledTimes(2);
    expect(toolRegistry.unregisterMcp).toHaveBeenCalledWith(
      tool.qualifiedName,
      expect.objectContaining({ serverToolName: tool.serverToolName }),
    );
    expect(store.cacheTools).toHaveBeenCalledTimes(2);
  });

  it('动态工具批次发生所有权冲突时保留上一版完整工具表', async () => {
    const conflictingTool: McpToolInfo = {
      ...tool,
      serverToolName: 'conflict',
      qualifiedName: 'builtin_name',
    };
    let notificationHandler: (() => void | Promise<void>) | undefined;
    const client = {
      setNotificationHandler: vi.fn((_schema: unknown, handler: () => void | Promise<void>) => {
        notificationHandler = handler;
      }),
    };
    mocks.openConnection.mockResolvedValue({
      client,
      cleanup: vi.fn(async () => undefined),
    });
    mocks.discoverServerTools
      .mockResolvedValueOnce([tool])
      .mockResolvedValueOnce([conflictingTool]);
    const { registry, store, toolRegistry } = createHarness();
    toolRegistry.registerMcpBatch
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('tool ownership conflict'); });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await registry.connectConfig('remote', config);
    await notificationHandler?.();
    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to refresh tools'),
    ));

    expect(registry.getTools('remote')).toEqual([tool]);
    expect(toolRegistry.unregisterMcp).not.toHaveBeenCalled();
    expect(store.cacheTools).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it('启动刷新最多同时连接四个 Server', async () => {
    const records = Array.from({ length: 9 }, (_, index) => ({
      name: `server-${index}`,
      config: {
        type: 'http' as const,
        url: `https://example.com/mcp/${index}`,
      },
    }));
    const store = {
      listEnabled: vi.fn(() => records),
      cacheTools: vi.fn(),
    } as never;
    const toolRegistry = {
      registerMcpBatch: vi.fn(),
      unregisterMcp: vi.fn(),
    } as never;
    let active = 0;
    let maximumActive = 0;
    mocks.openConnection.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { client: clientStub(), cleanup: vi.fn(async () => undefined) };
    });
    mocks.discoverServerTools.mockResolvedValue([]);
    const registry = new McpRegistry(store, toolRegistry);

    await registry.startAll();

    expect(mocks.openConnection).toHaveBeenCalledTimes(9);
    expect(maximumActive).toBe(4);
  });
});
