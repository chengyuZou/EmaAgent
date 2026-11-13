import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { Database, McpOAuthCredentialsRepo, McpServersRepo } from '@ema-agent/storage';
import { McpOAuthClient } from '../auth/oauthClient.js';
import { startOAuthLogin } from '../auth/oauthLogin.js';

let mockAuthImplementation: (
  client: McpOAuthClient,
  opts: { serverUrl: string; authorizationCode?: string },
) => Promise<'REDIRECT' | 'AUTHORIZED'>;

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  auth: (client: McpOAuthClient, opts: { serverUrl: string; authorizationCode?: string }) =>
    mockAuthImplementation(client, opts),
  UnauthorizedError: class UnauthorizedError extends Error {
    constructor(msg?: string) {
      super(msg ?? 'Unauthorized');
      this.name = 'UnauthorizedError';
    }
  },
}));

describe('startOAuthLogin 本地回环登录测试', () => {
  let database: Database;
  let serversRepo: McpServersRepo;
  let credentialsRepo: McpOAuthCredentialsRepo;
  let client: McpOAuthClient;

  beforeEach(async () => {
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();
    serversRepo = new McpServersRepo(database.sqlite);
    credentialsRepo = new McpOAuthCredentialsRepo(database.sqlite);

    serversRepo.insert({
      id: 'srv-login-test',
      name: 'notion',
      install_source: 'manual',
      market_entry_id: null,
      config_json: JSON.stringify({ type: 'http', url: 'https://mcp.notion.com/mcp' }),
      tools_cache: null,
      enabled: 1,
      auth_type: 'oauth',
      installed_at: 1000,
    });

    client = new McpOAuthClient('srv-login-test', 'https://mcp.notion.com/mcp', credentialsRepo);

    mockAuthImplementation = async (c, opts) => {
      if (opts.authorizationCode) {
        // 兑换阶段
        await c.saveTokens({
          access_token: 'new-token-123',
          refresh_token: 'new-refresh-456',
          token_type: 'Bearer',
          expires_in: 3600,
        });
        return 'AUTHORIZED';
      }
      // 初次重定向阶段 (模拟 SDK 动态客户端注册保存 client_id)
      await c.saveClientInformation({ client_id: 'client-dynamic-123' });
      c.redirectToAuthorization(new URL('https://mcp.notion.com/authorize?client_id=ema'));
      return 'REDIRECT';
    };
  });

  afterEach(() => database.close());

  it('正常流程: 申请临时端口, 接收浏览器有效回调后成功保存 Token 并关闭端口', async () => {
    const result = await startOAuthLogin({
      serverId: 'srv-login-test',
      serverName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      client,
    });

    expect(result.authorizationUrl).toBe('https://mcp.notion.com/authorize?client_id=ema');

    const pending = client.getPendingLogin();
    expect(pending).toBeDefined();
    expect(pending?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

    // 模拟浏览器收到重定向并回调本地回环地址
    const callbackUrl = `${pending!.redirectUri}?code=auth_code_xyz&state=${pending!.state}`;
    const response = await fetch(callbackUrl);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('授权成功');

    // 任务异步 Promise 应完成
    await pending!.promise;

    // 凭据应已存入数据库
    const saved = credentialsRepo.findByServerId('srv-login-test');
    expect(saved?.access_token).toBe('new-token-123');
    expect(saved?.refresh_token).toBe('new-refresh-456');

    // 回调服务器应已关闭
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });

  it('被用户拒绝: 浏览器返回 error 参数时展示错误页面并拒绝流程', async () => {
    await startOAuthLogin({
      serverId: 'srv-login-test',
      serverName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      client,
    });

    const pending = client.getPendingLogin();
    const pendingExpectation = expect(pending!.promise).rejects.toThrow(/User cancelled/);

    const callbackUrl = `${pending!.redirectUri}?error=access_denied&error_description=User+cancelled`;
    const response = await fetch(callbackUrl);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('授权未完成');
    expect(html).toContain('User cancelled');

    await pendingExpectation;
  });

  it('防跨站伪造: state 不匹配时返回 400 并拒绝流程', async () => {
    await startOAuthLogin({
      serverId: 'srv-login-test',
      serverName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      client,
    });

    const pending = client.getPendingLogin();
    const pendingExpectation = expect(pending!.promise).rejects.toThrow(/mismatch/);

    const callbackUrl = `${pending!.redirectUri}?code=xyz&state=wrong_state`;
    const response = await fetch(callbackUrl);
    expect(response.status).toBe(400);

    await pendingExpectation;
  });

  it('用户主动取消: 取消任务即刻释放端口资源', async () => {
    await startOAuthLogin({
      serverId: 'srv-login-test',
      serverName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      client,
    });

    const pending = client.getPendingLogin();
    expect(pending).toBeDefined();

    const redirectUri = pending!.redirectUri;
    await client.cancelPendingLogin();
    await expect(pending!.promise).rejects.toThrow(/cancelled/i);

    // 端口应已关闭
    await expect(fetch(redirectUri)).rejects.toThrow();
  });
});
