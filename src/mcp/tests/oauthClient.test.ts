import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, McpOAuthCredentialsRepo, McpServersRepo } from '@ema-agent/storage';
import { McpOAuthClient } from '../auth/oauthClient.js';
import type { McpOAuthPendingLogin } from '../auth/types.js';

describe('McpOAuthClient 单元测试', () => {
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
      id: 'srv-1',
      name: 'notion',
      install_source: 'manual',
      market_entry_id: null,
      config_json: JSON.stringify({ type: 'http', url: 'https://mcp.notion.com/mcp' }),
      tools_cache: null,
      enabled: 1,
      auth_type: 'oauth',
      installed_at: 1000,
    });

    client = new McpOAuthClient('srv-1', 'https://mcp.notion.com/mcp', credentialsRepo);
  });

  afterEach(() => database.close());

  it('读取与保存动态注册客户端信息', async () => {
    expect(await client.clientInformation()).toBeUndefined();

    await client.saveClientInformation({
      client_id: 'client-notion-id',
      client_secret: 'client-notion-secret',
    });

    const info = await client.clientInformation();
    expect(info).toEqual({
      client_id: 'client-notion-id',
      client_secret: 'client-notion-secret',
    });
  });

  it('未注册客户端直接保存 Token 时抛出明确异常', async () => {
    await expect(
      client.saveTokens({
        access_token: 'token-orphan',
        token_type: 'Bearer',
      }),
    ).rejects.toThrow(/client registration record not found/);
  });

  it('读取与保存 Token, 计算剩余有效期秒数', async () => {
    expect(await client.tokens()).toBeUndefined();

    await client.saveClientInformation({ client_id: 'client-notion-id' });

    const expiresInSec = 3600;
    await client.saveTokens({
      access_token: 'access-token-1',
      refresh_token: 'refresh-token-1',
      token_type: 'Bearer',
      expires_in: expiresInSec,
    });

    const tokens = await client.tokens();
    expect(tokens?.access_token).toBe('access-token-1');
    expect(tokens?.refresh_token).toBe('refresh-token-1');
    expect(tokens?.expires_in).toBeGreaterThanOrEqual(3590);
    expect(tokens?.expires_in).toBeLessThanOrEqual(3600);
  });

  it('乐观锁版本不一致时安全丢弃迟到的 Token 更新', async () => {
    await client.saveClientInformation({ client_id: 'client-1' });

    await client.saveTokens({
      access_token: 'token-initial',
      refresh_token: 'refresh-initial',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    // 模拟另一操作清除了 Token 使版本号增加
    credentialsRepo.clearTokens('srv-1', Date.now());

    // 迟到的异步续期尝试写库, 应被乐观锁拦截
    const staleUpdateSuccess = credentialsRepo.updateTokensIfVersionMatches({
      mcpServerId: 'srv-1',
      version: 1, // 旧版本号
      accessToken: 'stale-token',
      updatedAt: Date.now(),
    });
    expect(staleUpdateSuccess).toBe(false);

    const currentTokens = await client.tokens();
    expect(currentTokens).toBeUndefined();
  });

  it('挂载授权任务, 读取 state 与 PKCE Verifier, 取消时清理', async () => {
    expect(client.redirectUrl).toBeUndefined();

    let cleanedUp = false;
    const mockPending: McpOAuthPendingLogin = {
      serverId: 'srv-1',
      serverName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      state: 'state-random-xyz',
      redirectUri: 'http://127.0.0.1:54321/oauth/callback',
      codeVerifier: 'verifier-abc',
      cleanup: async () => {
        cleanedUp = true;
      },
      promise: Promise.resolve(),
      abortController: new AbortController(),
    };

    await client.attachPendingLogin(mockPending);
    expect(client.redirectUrl).toBe('http://127.0.0.1:54321/oauth/callback');
    expect(client.state()).toBe('state-random-xyz');
    expect(client.codeVerifier()).toBe('verifier-abc');

    client.saveCodeVerifier('verifier-new');
    expect(client.codeVerifier()).toBe('verifier-new');

    await client.cancelPendingLogin();
    expect(client.redirectUrl).toBeUndefined();
    expect(cleanedUp).toBe(true);
  });

  it('挂载新授权任务时, 会先等待旧任务的端口与资源物理清理完毕', async () => {
    let oldCleanedUp = false;
    let oldAborted = false;

    const oldPending: McpOAuthPendingLogin = {
      serverId: 'srv-1',
      serverName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      state: 'state-old',
      redirectUri: 'http://127.0.0.1:54321/oauth/callback',
      cleanup: async () => {
        await new Promise((r) => setTimeout(r, 10));
        oldCleanedUp = true;
      },
      promise: Promise.resolve(),
      abortController: new AbortController(),
    };
    oldPending.abortController.signal.addEventListener('abort', () => {
      oldAborted = true;
    });

    await client.attachPendingLogin(oldPending);
    expect(client.getPendingLogin()?.state).toBe('state-old');

    const newPending: McpOAuthPendingLogin = {
      serverId: 'srv-1',
      serverName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      state: 'state-new',
      redirectUri: 'http://127.0.0.1:54322/oauth/callback',
      cleanup: async () => {},
      promise: Promise.resolve(),
      abortController: new AbortController(),
    };

    // 挂载新任务
    await client.attachPendingLogin(newPending);

    // 断言旧任务已被确凿中止且等待其 cleanup 彻底执行完成
    expect(oldAborted).toBe(true);
    expect(oldCleanedUp).toBe(true);
    expect(client.getPendingLogin()?.state).toBe('state-new');
  });

  it('三态状态机转移: required -> authorizing -> authorized', async () => {
    // 初始状态: required
    expect(client.getStatus().status).toBe('required');

    // 挂载授权任务后: authorizing
    const mockPending: McpOAuthPendingLogin = {
      serverId: 'srv-1',
      serverName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      state: 'state-123',
      redirectUri: 'http://127.0.0.1:54321/oauth/callback',
      cleanup: async () => {},
      promise: Promise.resolve(),
      abortController: new AbortController(),
    };
    await client.attachPendingLogin(mockPending);
    expect(client.getStatus().status).toBe('authorizing');

    // 登录完成后保存 Token: authorized
    await client.saveClientInformation({ client_id: 'client-notion-id' });
    await client.cancelPendingLogin();
    await client.saveTokens({
      access_token: 'valid-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    expect(client.getStatus().status).toBe('authorized');
  });

  it('Token 过期与 30 秒安全阈值判断', async () => {
    // 尚未保存 Token 时返回 true
    expect(client.isTokenExpiredOrNearExpiry()).toBe(true);

    await client.saveClientInformation({ client_id: 'client-notion-id' });

    // 有效期在 1 小时后
    await client.saveTokens({
      access_token: 'token-valid',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    expect(client.isTokenExpiredOrNearExpiry()).toBe(false);

    // 有效期只剩 10 秒, 处于 30 秒安全时间窗口内
    await client.saveTokens({
      access_token: 'token-soon-expire',
      token_type: 'Bearer',
      expires_in: 10,
    });
    expect(client.isTokenExpiredOrNearExpiry(30_000)).toBe(true);
  });
});
