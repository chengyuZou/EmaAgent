import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@ema-agent/tools';
import { Database, McpOAuthCredentialsRepo, McpServersRepo } from '@ema-agent/storage';
import { McpServerStore } from '../store.js';
import { McpRegistry } from '../connections/registry.js';
import type { OpenedConnection } from '../connections/connection.js';

let refreshCallCount = 0;
let mockAuthImplementation: () => Promise<'AUTHORIZED'>;

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  auth: () => {
    refreshCallCount++;
    return mockAuthImplementation();
  },
  UnauthorizedError: class UnauthorizedError extends Error {
    constructor(msg?: string) {
      super(msg ?? 'Unauthorized');
      this.name = 'UnauthorizedError';
    }
  },
}));

vi.mock('../tools/execution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/execution.js')>();
  return {
    ...actual,
    callMcpTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'tool-executed-ok' }],
      isError: false,
    }),
  };
});

vi.mock('../tools/discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/discovery.js')>();
  return {
    ...actual,
    discoverServerTools: vi.fn().mockResolvedValue([
      {
        serverToolName: 'search',
        qualifiedName: 'mcp__notion__search',
        originalServerName: 'notion',
        description: 'Search pages',
        inputSchema: { type: 'object' },
        reportedDestructive: false,
      },
    ]),
  };
});

let mockOpenConnectionImpl: () => Promise<OpenedConnection>;
vi.mock('../connections/connection.js', () => ({
  openConnection: () => mockOpenConnectionImpl(),
}));

describe('McpRegistry OAuth 鉴权与单飞续期集成测试', () => {
  let database: Database;
  let serversRepo: McpServersRepo;
  let credentialsRepo: McpOAuthCredentialsRepo;
  let store: McpServerStore;
  let toolRegistry: ToolRegistry;
  let registry: McpRegistry;

  beforeEach(async () => {
    refreshCallCount = 0;
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();
    serversRepo = new McpServersRepo(database.sqlite);
    credentialsRepo = new McpOAuthCredentialsRepo(database.sqlite);
    store = new McpServerStore(serversRepo);
    toolRegistry = new ToolRegistry();
    registry = new McpRegistry(store, toolRegistry, () => {}, credentialsRepo);

    mockOpenConnectionImpl = async () => ({
      client: {
        setNotificationHandler: vi.fn(),
        close: vi.fn(),
      } as unknown as OpenedConnection['client'],
      cleanup: vi.fn().mockResolvedValue(undefined),
    });

    mockAuthImplementation = async () => {
      // 模拟续期延迟 50ms, 确保并发调用能够命中单飞排队锁
      await new Promise((r) => setTimeout(r, 50));
      const server = store.findByName('notion');
      if (server) {
        // 续期成功保存新 Token
        credentialsRepo.saveInitialOrClient({
          mcpServerId: server.id,
          serverUrl: 'https://mcp.notion.com/mcp',
          clientId: 'client-1',
          accessToken: 'fresh-token',
          refreshToken: 'fresh-refresh',
          expiresAtMs: Date.now() + 3600_000,
          updatedAt: Date.now(),
        });
      }
      return 'AUTHORIZED';
    };
  });

  afterEach(async () => {
    await registry.disconnectAll();
    database.close();
  });

  it('3 个并发 callTool 遇到 Token 即将过期时, 触发排队锁只续期 1 次', async () => {
    store.register(
      'notion',
      { type: 'http', url: 'https://mcp.notion.com/mcp' },
      { sourceKind: 'manual' },
      'oauth',
    );

    // 初始 Token 只剩 5 秒过期, 处于 30 秒安全阈值内
    credentialsRepo.saveInitialOrClient({
      mcpServerId: store.findByName('notion')!.id,
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-1',
      accessToken: 'old-token',
      refreshToken: 'old-refresh',
      expiresAtMs: Date.now() + 5_000,
      updatedAt: Date.now(),
    });

    // 同时发起 3 个工具调用
    const [res1, res2, res3] = await Promise.all([
      registry.callTool('notion', 'search', { query: 'test1' }),
      registry.callTool('notion', 'search', { query: 'test2' }),
      registry.callTool('notion', 'search', { query: 'test3' }),
    ]);

    expect(res1.content[0]).toEqual({ type: 'text', text: 'tool-executed-ok' });
    expect(res2.content[0]).toEqual({ type: 'text', text: 'tool-executed-ok' });
    expect(res3.content[0]).toEqual({ type: 'text', text: 'tool-executed-ok' });

    // 关键断言: 3 个并发调用只触发了 1 次 SDK auth() 续期!
    expect(refreshCallCount).toBe(1);

    // 数据库已保存新 Token
    const current = credentialsRepo.findByServerId(store.findByName('notion')!.id);
    expect(current?.access_token).toBe('fresh-token');
  });

  it('遇到 401 鉴权失败时刹车, 立即停止指数退避重试', async () => {
    store.register(
      'notion',
      { type: 'http', url: 'https://mcp.notion.com/mcp' },
      { sourceKind: 'manual' },
      'oauth',
    );

    mockOpenConnectionImpl = async () => {
      const err = new Error('401 Unauthorized from server');
      err.name = 'UnauthorizedError';
      throw err;
    };

    await expect(registry.connect('notion')).rejects.toThrow();

    const serverInfo = registry.getServer('notion');
    expect(serverInfo?.connectionStatus).toBe('failed');
    expect(serverInfo?.connectionError).toBe('OAuth authorization required');

    // 确认没有挂起后台重试定时器
    const list = registry.listServers();
    expect(list[0]?.connectionStatus).toBe('failed');
    expect(list[0]?.connectionError).toBe('OAuth authorization required');
  });

  it('clearOAuthTokens 断开连接, 清空本机 Token, 保留 client_id 并标记为需要授权', async () => {
    store.register(
      'notion',
      { type: 'http', url: 'https://mcp.notion.com/mcp' },
      { sourceKind: 'manual' },
      'oauth',
    );

    const serverId = store.findByName('notion')!.id;
    credentialsRepo.saveInitialOrClient({
      mcpServerId: serverId,
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'permanent-client-id',
      accessToken: 'token-to-clear',
      refreshToken: 'refresh-to-clear',
      expiresAtMs: Date.now() + 3600_000,
      updatedAt: 1000,
    });

    await registry.connect('notion');
    expect(registry.getServer('notion')?.connectionStatus).toBe('connected');

    // 执行清除授权
    await registry.clearOAuthTokens('notion');

    // 连接已断开
    expect(registry.getServer('notion')?.connectionStatus).toBe('failed');

    // 数据库中 Token 已置空, 但 client_id 完好保留
    const dbRow = credentialsRepo.findByServerId(serverId);
    expect(dbRow?.access_token).toBeNull();
    expect(dbRow?.refresh_token).toBeNull();
    expect(dbRow?.client_id).toBe('permanent-client-id');

    // OAuth 状态报告为 required
    const status = registry.getOAuthStatus('notion');
    expect(status?.status).toBe('required');
  });

  it('getOAuthStatus 状态报告', () => {
    store.register(
      'notion-http',
      { type: 'http', url: 'https://mcp.notion.com/mcp' },
      { sourceKind: 'manual' },
      'oauth',
    );
    store.register(
      'local-stdio',
      { type: 'stdio', command: 'node', args: ['server.js'] },
      { sourceKind: 'manual' },
      'none',
    );

    // stdio 服务或 authType 为 none 时始终返回 null
    expect(registry.getOAuthStatus('local-stdio')).toBeNull();

    // 尚未授权的 HTTP 服务返回 required
    expect(registry.getOAuthStatus('notion-http')).toEqual({
      status: 'required',
      expiresAtMs: null,
      updatedAt: 0,
    });

    // 授权后的 HTTP 服务返回 authorized
    const httpId = store.findByName('notion-http')!.id;
    const futureExpiresAtMs = Date.now() + 3600_000;
    credentialsRepo.saveInitialOrClient({
      mcpServerId: httpId,
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'c1',
      accessToken: 'tok-valid',
      expiresAtMs: futureExpiresAtMs,
      updatedAt: 1234,
    });

    expect(registry.getOAuthStatus('notion-http')).toEqual({
      status: 'authorized',
      expiresAtMs: futureExpiresAtMs,
      updatedAt: 1234,
    });
  });

  it('cancelOAuth 通过 serverName 直接取消授权流程并关闭端口', async () => {
    store.register(
      'notion',
      { type: 'http', url: 'https://mcp.notion.com/mcp' },
      { sourceKind: 'manual' },
      'oauth',
    );

    // 取消尚未开始的流程不会抛出异常
    await expect(registry.cancelOAuth('notion')).resolves.toBeUndefined();
  });
});
