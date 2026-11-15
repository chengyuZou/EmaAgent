import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, McpOAuthCredentialsRepo, McpServersRepo } from '@ema-agent/storage';
import { McpOAuthClient } from '../auth/oauthClient.js';
import type { McpOAuthPendingLogin } from '../auth/types.js';
import { openConnection } from '../connections/connection.js';

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function startLocalTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind local test HTTP server');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

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

    client = new McpOAuthClient('notion', 'https://mcp.notion.com/mcp', credentialsRepo);
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
    credentialsRepo.clearTokens('notion', Date.now());

    // 迟到的异步续期尝试写库, 应被乐观锁拦截
    const staleUpdateSuccess = credentialsRepo.updateTokensIfVersionMatches({
      mcpServerName: 'notion',
      version: 1, // 旧版本号
      accessToken: 'stale-token',
      updatedAt: Date.now(),
    });
    expect(staleUpdateSuccess).toBe(false);

    const currentTokens = await client.tokens();
    expect(currentTokens).toBeUndefined();
  });

  it('挂载授权任务并记录 authorizing 状态与 authorizationUrl, 取消时清理', async () => {
    expect(client.getPendingLogin()).toBeUndefined();

    let cleanedUp = false;
    const mockPending: McpOAuthPendingLogin = {
      state: 'state-random-xyz',
      redirectUri: 'http://127.0.0.1:54321/oauth/callback',
      codeVerifier: 'verifier-abc',
      authorizationUrl: new URL('https://mcp.notion.com/authorize?state=state-random-xyz'),
      startedAt: 12345,
      cleanup: async () => {
        cleanedUp = true;
      },
      promise: Promise.resolve(),
      abortController: new AbortController(),
    };

    await client.attachPendingLogin(mockPending);
    expect(client.getPendingLogin()).toBe(mockPending);
    expect(client.getStatus()).toEqual({
      status: 'authorizing',
      authorizationUrl: 'https://mcp.notion.com/authorize?state=state-random-xyz',
      expiresAtMs: null,
      updatedAt: 12345,
    });

    await client.cancelPendingLogin();
    expect(client.getPendingLogin()).toBeUndefined();
    expect(client.getStatus().status).toBe('required');
    expect(cleanedUp).toBe(true);
  });

  it('挂载新授权任务时, 会先等待旧任务的端口与资源物理清理完毕', async () => {
    let oldCleanedUp = false;
    let oldAborted = false;

    const oldPending: McpOAuthPendingLogin = {
      state: 'state-old',
      redirectUri: 'http://127.0.0.1:54321/oauth/callback',
      startedAt: 1000,
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
      state: 'state-new',
      redirectUri: 'http://127.0.0.1:54322/oauth/callback',
      startedAt: 2000,
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
      state: 'state-123',
      redirectUri: 'http://127.0.0.1:54321/oauth/callback',
      startedAt: 1000,
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

  it('Bug 1 真实 SDK 续期: 无 pendingLogin 时 ensureFreshToken 直接用 refresh_token 换取新 Token', async () => {
    let tokenRequestBody = '';
    const oauthServer = await startLocalTestServer(async (req, res) => {
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            issuer: oauthServer.baseUrl,
            authorization_endpoint: `${oauthServer.baseUrl}/authorize`,
            token_endpoint: `${oauthServer.baseUrl}/token`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_method: 'none',
          }),
        );
        return;
      }

      if (req.url === '/token' && req.method === 'POST') {
        tokenRequestBody = await readRequestBody(req);
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            access_token: 'sdk-fresh-access',
            refresh_token: 'sdk-fresh-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    try {
      const serverUrl = `${oauthServer.baseUrl}/mcp`;
      const liveClient = new McpOAuthClient('notion', serverUrl, credentialsRepo);

      await liveClient.saveClientInformation({ client_id: 'client-live-1' });
      credentialsRepo.saveInitialOrClient({
        mcpServerName: 'notion',
        serverUrl,
        clientId: 'client-live-1',
        accessToken: 'expired-access',
        refreshToken: 'old-refresh-token',
        expiresAtMs: Date.now() - 1000,
        updatedAt: 1000,
      });

      await liveClient.ensureFreshToken();

      const params = new URLSearchParams(tokenRequestBody);
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('old-refresh-token');

      const updated = credentialsRepo.findByServerName('notion');
      expect(updated?.access_token).toBe('sdk-fresh-access');
      expect(updated?.refresh_token).toBe('sdk-fresh-refresh');
    } finally {
      await oauthServer.close();
    }
  });

  it('Bug 1/2 真实 SDK InvalidGrant 与乐观锁保护: 仅在版本与 refresh_token 一致时清空或写回', async () => {
    let tokenStatusCode = 400;
    let tokenResponseBody: Record<string, unknown> = {
      error: 'invalid_grant',
      error_description: 'refresh token revoked',
    };
    let onTokenRequest: (() => Promise<void> | void) | undefined;

    const oauthServer = await startLocalTestServer(async (req, res) => {
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            issuer: oauthServer.baseUrl,
            authorization_endpoint: `${oauthServer.baseUrl}/authorize`,
            token_endpoint: `${oauthServer.baseUrl}/token`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_method: 'none',
          }),
        );
        return;
      }

      if (req.url === '/token' && req.method === 'POST') {
        await readRequestBody(req);
        if (onTokenRequest) {
          await onTokenRequest();
        }
        res.statusCode = tokenStatusCode;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(tokenResponseBody));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    try {
      const serverUrl = `${oauthServer.baseUrl}/mcp`;
      const liveClient = new McpOAuthClient('notion', serverUrl, credentialsRepo);

      // Case A: 当前 refresh 收到 invalid_grant 时清空本机 Token 并保留 client_id
      credentialsRepo.saveInitialOrClient({
        mcpServerName: 'notion',
        serverUrl,
        clientId: 'client-permanent',
        accessToken: 'expired-access',
        refreshToken: 'revoked-refresh',
        expiresAtMs: Date.now() - 1000,
        updatedAt: 1000,
      });
      await liveClient.ensureFreshToken();

      const afterRevoke = credentialsRepo.findByServerName('notion');
      expect(afterRevoke?.access_token).toBeNull();
      expect(afterRevoke?.refresh_token).toBeNull();
      expect(afterRevoke?.client_id).toBe('client-permanent');

      // Case B: 续期成功回包前若已被清除授权, 迟到的成功结果不得写回
      credentialsRepo.saveInitialOrClient({
        mcpServerName: 'notion',
        serverUrl,
        clientId: 'client-permanent',
        accessToken: 'expired-access-2',
        refreshToken: 'refresh-2',
        expiresAtMs: Date.now() - 1000,
        updatedAt: 2000,
      });
      tokenStatusCode = 200;
      tokenResponseBody = {
        access_token: 'late-fresh-access',
        refresh_token: 'late-fresh-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      };
      onTokenRequest = () => {
        credentialsRepo.clearTokens('notion', Date.now());
      };

      await liveClient.ensureFreshToken();
      const afterClearedDuringRefresh = credentialsRepo.findByServerName('notion');
      expect(afterClearedDuringRefresh?.access_token).toBeNull();
      expect(afterClearedDuringRefresh?.refresh_token).toBeNull();

      // Case C: 续期途中已被写入新一轮有效 Token 后, 旧请求收到 invalid_grant 不得误删新 Token
      credentialsRepo.saveInitialOrClient({
        mcpServerName: 'notion',
        serverUrl,
        clientId: 'client-permanent',
        accessToken: 'expired-access-3',
        refreshToken: 'old-refresh-3',
        expiresAtMs: Date.now() - 1000,
        updatedAt: 3000,
      });
      tokenStatusCode = 400;
      tokenResponseBody = {
        error: 'invalid_grant',
        error_description: 'old refresh expired',
      };
      onTokenRequest = () => {
        credentialsRepo.saveInitialOrClient({
          mcpServerName: 'notion',
          serverUrl,
          clientId: 'client-permanent',
          accessToken: 'newer-login-access',
          refreshToken: 'newer-login-refresh',
          expiresAtMs: Date.now() + 3600_000,
          updatedAt: Date.now(),
        });
      };

      await liveClient.ensureFreshToken();
      const afterNewerLogin = credentialsRepo.findByServerName('notion');
      expect(afterNewerLogin?.access_token).toBe('newer-login-access');
      expect(afterNewerLogin?.refresh_token).toBe('newer-login-refresh');
    } finally {
      await oauthServer.close();
    }
  });

  it('Bug 4 与 401 识别: serverUrl 不匹配时不读取凭据也不附带 Bearer, openConnection 401 转明确消息', async () => {
    const observedHeaders: Array<string | undefined> = [];
    let responseStatus = 200;

    const mcpServer = await startLocalTestServer(async (req, res) => {
      observedHeaders.push(req.headers.authorization);
      if (responseStatus === 401) {
        res.statusCode = 401;
        // 故意返回空 body, 验证 connection.ts 不依赖响应文本即可识别 code=401
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });

    try {
      const urlA = `${mcpServer.baseUrl}/mcp`;
      const urlB = `${mcpServer.baseUrl}/other-mcp`;
      credentialsRepo.saveInitialOrClient({
        mcpServerName: 'notion',
        serverUrl: urlA,
        clientId: 'client-a',
        accessToken: 'secret-token-a',
        expiresAtMs: Date.now() + 3600_000,
        updatedAt: 1000,
      });

      const clientA = new McpOAuthClient('notion', urlA, credentialsRepo);
      const clientB = new McpOAuthClient('notion', urlB, credentialsRepo);

      // URL 不匹配的 clientB 读不到客户端信息与 Token, 状态必须为 required
      expect(await clientB.clientInformation()).toBeUndefined();
      expect(await clientB.tokens()).toBeUndefined();
      expect(clientB.getStatus().status).toBe('required');

      // fetchWithOAuth 只为匹配 URL 附带 Authorization 头
      await clientA.fetchWithOAuth(urlA, { method: 'POST' });
      await clientB.fetchWithOAuth(urlB, { method: 'POST' });
      expect(observedHeaders).toEqual(['Bearer secret-token-a', undefined]);

      // 验证 openConnection 在遇到 HTTP 401 时附带了 oauthFetch 且抛出含 HTTP 401 Unauthorized 的错误
      responseStatus = 401;
      await expect(
        openConnection(
          'notion',
          { type: 'http', url: urlA },
          undefined,
          clientA.fetchWithOAuth,
        ),
      ).rejects.toThrow(/HTTP 401 Unauthorized/);
      expect(observedHeaders.at(-1)).toBe('Bearer secret-token-a');
    } finally {
      await mcpServer.close();
    }
  });
});
