import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { Database, McpOAuthCredentialsRepo, McpServersRepo } from '@ema-agent/storage';
import { McpOAuthClient } from '../auth/oauthClient.js';
import { startOAuthLogin } from '../auth/oauthLogin.js';

interface MockProviderLike {
  saveTokens: (tokens: {
    access_token: string;
    token_type: string;
    refresh_token?: string;
    expires_in?: number;
  }) => Promise<void>;
  saveClientInformation: (info: { client_id: string; client_secret?: string }) => Promise<void>;
  redirectToAuthorization: (authorizationUrl: URL) => void;
}

let mockAuthImplementation: (
  client: MockProviderLike,
  opts: {
    serverUrl: string | URL;
    authorizationCode?: string;
    fetchFn?: typeof fetch;
  },
) => Promise<'REDIRECT' | 'AUTHORIZED'>;

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  auth: (
    client: MockProviderLike,
    opts: {
      serverUrl: string | URL;
      authorizationCode?: string;
      fetchFn?: typeof fetch;
    },
  ) => mockAuthImplementation(client, opts),
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

    client = new McpOAuthClient('notion', 'https://mcp.notion.com/mcp', credentialsRepo);

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
      serverName: 'notion',
      client,
    });

    expect(result.authorizationUrl).toBe('https://mcp.notion.com/authorize?client_id=ema');

    const pending = client.getPendingLogin();
    expect(pending).toBeDefined();
    expect(pending?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    expect(client.getStatus()).toMatchObject({
      status: 'authorizing',
      authorizationUrl: 'https://mcp.notion.com/authorize?client_id=ema',
    });

    // 模拟浏览器收到重定向并回调本地回环地址
    const callbackUrl = `${pending!.redirectUri}?code=auth_code_xyz&state=${pending!.state}`;
    const response = await fetch(callbackUrl);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('授权成功');

    // 任务异步 Promise 应完成
    await pending!.promise;

    // 凭据应已存入数据库
    const saved = credentialsRepo.findByServerName('notion');
    expect(saved?.access_token).toBe('new-token-123');
    expect(saved?.refresh_token).toBe('new-refresh-456');

    // 回调服务器应已关闭
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });

  it('被用户拒绝: 浏览器返回 error 参数时展示错误页面并拒绝流程', async () => {
    await startOAuthLogin({
      serverName: 'notion',
      client,
    });

    const pending = client.getPendingLogin();
    const callbackUrl = `${pending!.redirectUri}?error=access_denied&error_description=User+cancelled&state=${pending!.state}`;
    const [response] = await Promise.all([
      fetch(callbackUrl),
      expect(pending!.promise).rejects.toThrow(/User cancelled/),
    ]);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('授权未完成');
    expect(html).toContain('User cancelled');
  });

  it('防跨站伪造: state 不匹配时仅返回 400 且不终止当前登录会话', async () => {
    await startOAuthLogin({
      serverName: 'notion',
      client,
    });

    const pending = client.getPendingLogin();
    expect(pending).toBeDefined();

    // 伪造请求带上 wrong_state 与 error 参数, 只应返回 400, 不能中止当前用户的登录流程
    const forgedResponse = await fetch(
      `${pending!.redirectUri}?error=access_denied&error_description=Forged&state=wrong_state`,
    );
    expect(forgedResponse.status).toBe(400);
    expect(client.getPendingLogin()).toBe(pending);

    // 真实回调依然能正常完成授权
    const validResponse = await fetch(
      `${pending!.redirectUri}?code=valid_code&state=${pending!.state}`,
    );
    expect(validResponse.status).toBe(200);
    await expect(pending!.promise).resolves.toBeUndefined();
    expect(credentialsRepo.findByServerName('notion')?.access_token).toBe('new-token-123');
  });

  it('重复回调防护: 授权码兑换期间再次请求返回 409 且只兑换 1 次', async () => {
    let exchangeCount = 0;
    let releaseExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });

    mockAuthImplementation = async (c, opts) => {
      if (opts.authorizationCode) {
        exchangeCount++;
        markExchangeStarted();
        await exchangeGate;
        await c.saveTokens({
          access_token: 'token-once',
          token_type: 'Bearer',
          expires_in: 3600,
        });
        return 'AUTHORIZED';
      }
      await c.saveClientInformation({ client_id: 'client-dynamic-123' });
      c.redirectToAuthorization(new URL('https://mcp.notion.com/authorize?client_id=ema'));
      return 'REDIRECT';
    };

    await startOAuthLogin({
      serverName: 'notion',
      client,
    });

    const pending = client.getPendingLogin()!;
    const validUrl = `${pending.redirectUri}?code=auth_code_once&state=${pending.state}`;
    const firstFetch = fetch(validUrl);
    await exchangeStarted;

    // 浏览器刷新触发第二次回调, 应返回 409 且不会重复调用 SDK 兑换
    const duplicateResponse = await fetch(validUrl);
    expect(duplicateResponse.status).toBe(409);
    expect(exchangeCount).toBe(1);

    releaseExchange();
    const firstResponse = await firstFetch;
    expect(firstResponse.status).toBe(200);
    await expect(pending.promise).resolves.toBeUndefined();
    expect(credentialsRepo.findByServerName('notion')?.access_token).toBe('token-once');
  });

  it('取消登录或清除凭据发生在授权码兑换途中时, 中止请求且迟到的 saveTokens 不回写', async () => {
    let observedFetchSignal: AbortSignal | undefined;
    let releaseExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });
    let markExchangeFinished!: () => void;
    const exchangeFinished = new Promise<void>((resolve) => {
      markExchangeFinished = resolve;
    });
    let saveAttemptError: unknown;

    mockAuthImplementation = async (c, opts) => {
      if (opts.authorizationCode) {
        try {
          expect(opts.fetchFn).toBeTypeOf('function');
          const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_input, init) => {
            observedFetchSignal = init?.signal ?? undefined;
            return new Response('{}', { status: 200 });
          });
          try {
            await opts.fetchFn!('https://oauth.example.test/token', { method: 'POST' });
          } finally {
            fetchSpy.mockRestore();
          }
          markExchangeStarted();
          await exchangeGate;
          // 即便旧兑换忽略中止继续调用 saveTokens, 也不能覆盖已清除的状态
          try {
            await c.saveTokens({
              access_token: 'stale-token-after-cancel',
              refresh_token: 'stale-refresh',
              token_type: 'Bearer',
              expires_in: 3600,
            });
          } catch (err) {
            saveAttemptError = err;
          }
          return 'AUTHORIZED';
        } finally {
          markExchangeFinished();
        }
      }
      await c.saveClientInformation({ client_id: 'client-dynamic-123' });
      c.redirectToAuthorization(new URL('https://mcp.notion.com/authorize?client_id=ema'));
      return 'REDIRECT';
    };

    await startOAuthLogin({
      serverName: 'notion',
      client,
    });

    const pending = client.getPendingLogin()!;
    const pendingRejection = expect(pending.promise).rejects.toThrow();
    const callbackFetch = fetch(`${pending.redirectUri}?code=late_code&state=${pending.state}`);
    const callbackSettled = callbackFetch.catch(() => undefined);
    await exchangeStarted;

    // 取消登录并清空本机凭据
    await client.cancelPendingLogin();
    credentialsRepo.clearTokens('notion', Date.now());
    expect(observedFetchSignal?.aborted).toBe(true);

    releaseExchange();
    await exchangeFinished;
    await callbackSettled;
    await pendingRejection;

    // 确认旧兑换触发 saveTokens 被拒绝且数据库 Token 保持为空
    expect(saveAttemptError).toBeDefined();
    expect(credentialsRepo.findByServerName('notion')?.access_token).toBeNull();
  });

  it('初始阶段在等待授权 URL 时被取消, cleanly reject 且无悬挂服务器或未处理拒绝', async () => {
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });

    mockAuthImplementation = async (c, opts) => {
      if (!opts.authorizationCode) {
        await c.saveClientInformation({ client_id: 'client-dynamic-123' });
        markDiscoveryStarted();
        await discoveryGate;
        c.redirectToAuthorization(new URL('https://mcp.notion.com/authorize?client_id=ema'));
        return 'REDIRECT';
      }
      return 'AUTHORIZED';
    };

    const loginPromise = startOAuthLogin({
      serverName: 'notion',
      client,
    });
    const loginRejection = expect(loginPromise).rejects.toThrow();
    await discoveryStarted;

    const pending = client.getPendingLogin()!;
    expect(pending).toBeDefined();
    const redirectUri = pending.redirectUri;

    await client.cancelPendingLogin();
    releaseDiscovery();

    await loginRejection;
    expect(client.getPendingLogin()).toBeUndefined();
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it('用户主动取消: 取消任务即刻释放端口资源', async () => {
    await startOAuthLogin({
      serverName: 'notion',
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

  it('初次 auth 直接返回 AUTHORIZED 时返回 null authorizationUrl 并立即释放端口', async () => {
    mockAuthImplementation = async () => 'AUTHORIZED';

    const result = await startOAuthLogin({
      serverName: 'notion',
      client,
    });

    expect(result).toEqual({ authorizationUrl: null });
    expect(client.getPendingLogin()).toBeUndefined();
  });
});
