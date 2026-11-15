import { logging } from '@ema-agent/logging';
import { waitForPromise } from '../connections/requestControl.js';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpOAuthCredentialsRepo, McpOAuthCredentialsRow } from '@ema-agent/storage';
import type { McpOAuthPendingLogin, McpOAuthStatus } from './types.js';

// SDK 的 selectResourceURL 接口声明需要 OAuthClientProvider, 实际只检查可选的 validateResourceURL 钩子.
const DEFAULT_RESOURCE_PROVIDER = {} as unknown as OAuthClientProvider;

/** 解析已持久化在数据库中的 DCR 回跳地址白名单 JSON 数组; 缺失或格式非法时返回空数组. */
function parseRegisteredRedirectUris(redirectUrisJson: string | null): string[] {
  if (!redirectUrisJson) return [];
  try {
    const parsed: unknown = JSON.parse(redirectUrisJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

/** 判断持久化记录里的 client_secret 是否已到达过期时间; null 表示无过期限制或长期有效. */
function isStoredClientSecretExpired(row: McpOAuthCredentialsRow, nowMs = Date.now()): boolean {
  return row.client_secret_expires_at_ms !== null && row.client_secret_expires_at_ms <= nowMs;
}

/** 将数据库凭据行还原为 SDK 可识别的客户端登记对象, 保留认证方式与回跳地址等元数据. */
function buildClientInformationFromRow(row: McpOAuthCredentialsRow): OAuthClientInformationMixed {
  const registeredUris = parseRegisteredRedirectUris(row.redirect_uris_json);
  const clientSecretExpiresAt =
    row.client_secret_expires_at_ms !== null
      ? Math.floor(row.client_secret_expires_at_ms / 1000)
      : undefined;

  if (registeredUris.length > 0) {
    return {
      client_id: row.client_id,
      ...(row.client_secret !== null ? { client_secret: row.client_secret } : {}),
      ...(clientSecretExpiresAt !== undefined ? { client_secret_expires_at: clientSecretExpiresAt } : {}),
      ...(row.token_endpoint_auth_method ? { token_endpoint_auth_method: row.token_endpoint_auth_method } : {}),
      redirect_uris: registeredUris,
    };
  }

  return {
    client_id: row.client_id,
    ...(row.client_secret !== null ? { client_secret: row.client_secret } : {}),
    ...(clientSecretExpiresAt !== undefined ? { client_secret_expires_at: clientSecretExpiresAt } : {}),
    ...(row.token_endpoint_auth_method
      ? ({ token_endpoint_auth_method: row.token_endpoint_auth_method } as Partial<OAuthClientInformationMixed>)
      : {}),
  } as OAuthClientInformationMixed;
}

/**
 * 针对单个 MCP HTTP 服务的 OAuth 凭据与登录会话状态管理.
 *
 * 桥接 @modelcontextprotocol/sdk 的 OAuth 授权层与 Ema 的 SQLite profile.db 存储.
 * 负责客户端注册信息读取, Token 存取(带乐观并发控制), 回环授权流程状态以及并发刷新排队锁.
 */
export class McpOAuthClient {
  /** 当前正在进行中的回环端口登录任务. */
  private pendingLogin?: McpOAuthPendingLogin;
  /** 当前正在排队或执行中的 Token 续期 Promise, 避免高并发调用工具时向鉴权服务器重复请求. */
  private pendingTokenRefresh?: Promise<void>;

  constructor(
    readonly serverName: string,
    readonly serverUrl: string,
    private readonly credentialsRepo: McpOAuthCredentialsRepo,
  ) {}

  /**
   * 为传输层 HTTP 请求动态注入当前有效的 Bearer Token.
   * 若服务地址与库内凭据记录不一致则不注入 Authorization 请求头.
   */
  readonly fetchWithOAuth: FetchLike = (url, init) => {
    const headers = new Headers(init?.headers);
    const accessToken = this.readCredentials()?.access_token;
    if (accessToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }
    return fetch(url, { ...init, headers });
  };

  /**
   * 按 serverName 读取并核对服务端 URL 一致的 OAuth 凭据行.
   */
  private readCredentials(): McpOAuthCredentialsRow | null {
    const row = this.credentialsRepo.findByServerName(this.serverName);
    return row?.server_url === this.serverUrl ? row : null;
  }

  /**
   * 读取已在服务端登记的客户端信息.
   * 若本地数据库未曾保存过 client_id, 地址不匹配或密钥已过期则返回 undefined.
   */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const row = this.readCredentials();
    if (!row || !row.client_id || isStoredClientSecretExpired(row)) {
      return undefined;
    }
    return buildClientInformationFromRow(row);
  }

  /**
   * 为本次回环登录读取客户端信息.
   * 仅当已登记的 redirect_uris 包含本次监听端口对应的 redirectUri 且密钥未过期时才复用;
   * 若随机端口已变化或历史记录尚未保存 redirect_uris, 返回 undefined 以触发 SDK 对新端口重新执行 DCR.
   */
  private clientInformationForLogin(redirectUri: string): OAuthClientInformationMixed | undefined {
    const row = this.readCredentials();
    if (!row || !row.client_id || isStoredClientSecretExpired(row)) {
      return undefined;
    }
    const registeredUris = parseRegisteredRedirectUris(row.redirect_uris_json);
    if (!registeredUris.includes(redirectUri)) {
      return undefined;
    }
    return buildClientInformationFromRow(row);
  }

  /**
   * 保存动态注册成功后服务端返回的客户端登记信息.
   * fallbackRedirectUris 仅在部分服务端 /register 响应省略 redirect_uris 时兜底记录本次实际回调地址.
   */
  async saveClientInformation(
    info: OAuthClientInformationMixed,
    fallbackRedirectUris?: string[],
  ): Promise<void> {
    const redirectUris =
      'redirect_uris' in info && Array.isArray(info.redirect_uris) && info.redirect_uris.length > 0
        ? info.redirect_uris
        : fallbackRedirectUris;
    const tokenEndpointAuthMethod =
      'token_endpoint_auth_method' in info ? (info.token_endpoint_auth_method ?? null) : null;
    // RFC 7591 规定 client_secret_expires_at 为 Unix 秒级时间戳, 0 表示永久有效.
    const clientSecretExpiresAtMs =
      typeof info.client_secret_expires_at === 'number' && info.client_secret_expires_at > 0
        ? info.client_secret_expires_at * 1000
        : null;

    this.credentialsRepo.saveInitialOrClient({
      mcpServerName: this.serverName,
      serverUrl: this.serverUrl,
      clientId: info.client_id,
      clientSecret: info.client_secret ?? null,
      tokenEndpointAuthMethod,
      redirectUrisJson: redirectUris ? JSON.stringify(redirectUris) : null,
      clientSecretExpiresAtMs,
      updatedAt: Date.now(),
    });
  }

  /**
   * 读取本地保存的 OAuth Tokens.
   * 若当前没有 Token 或服务端地址不匹配则返回 undefined.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    const row = this.readCredentials();
    if (!row || (!row.access_token && !row.refresh_token)) {
      return undefined;
    }
    const expiresIn =
      row.expires_at_ms !== null
        ? Math.max(0, Math.floor((row.expires_at_ms - Date.now()) / 1000))
        : undefined;

    return {
      access_token: row.access_token ?? '',
      token_type: 'Bearer',
      refresh_token: row.refresh_token ?? undefined,
      expires_in: expiresIn,
    };
  }

  /**
   * 保存授权或续期成功获得的新 Token.
   * 采用版本号条件更新. 若因用户取消, 清除授权或重新登录导致版本号不一致,
   * 则记录告警并拒绝覆盖当前凭据.
   */
  async saveTokens(tokens: OAuthTokens, expectedVersion?: number): Promise<void> {
    const current = this.readCredentials();
    if (!current) {
      throw new Error(`Cannot save OAuth tokens: client registration record not found for server "${this.serverName}".`);
    }
    const targetVersion = expectedVersion ?? current.version;

    const expiresAtMs =
      tokens.expires_in !== undefined && tokens.expires_in !== null
        ? Date.now() + Math.floor(Number(tokens.expires_in)) * 1000
        : null;

    const updated = this.credentialsRepo.updateTokensIfVersionMatches({
      mcpServerName: this.serverName,
      version: targetVersion,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAtMs,
      updatedAt: Date.now(),
    });
    if (!updated) {
      logging({
        level: 'warn',
        target: 'mcp',
        event: 'mcp.oauth.stale_tokens_rejected',
        message: `Stale OAuth token update rejected by optimistic lock. Server: ${this.serverName}, expected version ${targetVersion}, current version ${current.version}.`,
      });
      throw new Error('Stale OAuth token update rejected because credentials were changed.');
    }
  }

  /**
   * 在单次浏览器授权登录上下文中调用 SDK auth().
   * 通过闭包将本次 pendingLogin 对象引用, AbortSignal 与发请求前读到的版本号锁在一起,
   * 阻止取消或清除授权后迟到的网络回包改写新凭据.
   */
  async authorizeLogin(login: McpOAuthPendingLogin, authorizationCode?: string): Promise<'REDIRECT' | 'AUTHORIZED'> {
    const signal = login.abortController.signal;
    const readVersion = () => this.readCredentials()?.version;
    let expectedVersion = readVersion();
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.pendingLogin !== login || readVersion() !== expectedVersion) {
        throw new Error('Current OAuth login session is no longer active.');
      }
    };

    const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
    assertCurrent();

    const provider: OAuthClientProvider = {
      redirectUrl: login.redirectUri,
      clientMetadata: {
        client_name: 'EmaAgent',
        redirect_uris: [login.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      state: () => login.state,
      clientInformation: () => this.clientInformationForLogin(login.redirectUri),
      tokens: () => this.tokens(),
      discoveryState: () => login.discoveryState,
      saveDiscoveryState: (state: OAuthDiscoveryState) => {
        assertCurrent();
        login.discoveryState = state;
      },
      codeVerifier: () => {
        assertCurrent();
        if (!login.codeVerifier) {
          throw new Error('No active OAuth login task or missing PKCE code verifier.');
        }
        return login.codeVerifier;
      },
      saveCodeVerifier: (verifier) => {
        login.codeVerifier = verifier;
      },
      redirectToAuthorization: (url) => {
        assertCurrent();
        login.authorizationUrl = url;
      },
      saveClientInformation: async (info) => {
        assertCurrent();
        await this.saveClientInformation(info, [login.redirectUri]);
        expectedVersion = readVersion();
      },
      saveTokens: async (tokens) => {
        assertCurrent();
        await this.saveTokens(tokens, expectedVersion);
        expectedVersion = readVersion();
      },
      invalidateCredentials: async (scope) => {
        assertCurrent();
        // 换取 Token 失败(如 invalid_grant)时不再让 SDK 清除本地旧 Token 并重复提交失效授权码.
        if (authorizationCode && scope === 'tokens') {
          throw new Error('OAuth authorization code rejected by server.');
        }
        if (scope === 'discovery' || scope === 'all') {
          login.discoveryState = undefined;
        }
        await this.invalidateCredentials(scope);
        expectedVersion = readVersion();
      },
    };

    const result = await auth(provider, {
      serverUrl: this.serverUrl,
      authorizationCode,
      fetchFn: (url, init) => {
        assertCurrent();
        const combinedSignal = init?.signal
          ? AbortSignal.any([init.signal, signal])
          : signal;
        return fetch(url, { ...init, signal: combinedSignal });
      },
    });
    assertCurrent();
    return result;
  }

  private async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'tokens' || scope === 'all') {
      this.credentialsRepo.clearTokens(this.serverName, Date.now());
    }
    if (scope === 'client' || scope === 'all') {
      this.credentialsRepo.deleteByServerName(this.serverName);
    }
  }

  /**
   * 挂载活跃的浏览器授权任务.
   * 先同步登记新任务引用再中止并等待旧端口清理完毕, 避免清理等待期间新任务被旧任务覆盖.
   */
  async attachPendingLogin(pending: McpOAuthPendingLogin): Promise<void> {
    const oldTask = this.pendingLogin;
    this.pendingLogin = pending;
    if (oldTask && oldTask !== pending) {
      oldTask.abortController.abort();
      await oldTask.cleanup();
    }
  }

  /**
   * 当授权流程结束或自我收尾时同步解绑任务引用.
   * 仅做纯同步内存清理, 绝不反向调用 task.cleanup(), 杜绝循环 await 造成的死锁.
   */
  detachPendingLogin(state: string): void {
    if (this.pendingLogin?.state === state) {
      this.pendingLogin = undefined;
    }
  }

  /**
   * 取消并清理当前处于等待中的浏览器授权任务.
   */
  async cancelPendingLogin(): Promise<void> {
    if (!this.pendingLogin) return;
    const task = this.pendingLogin;
    this.pendingLogin = undefined;
    task.abortController.abort();
    await task.cleanup();
  }

  getPendingLogin(): McpOAuthPendingLogin | undefined {
    return this.pendingLogin;
  }

  /**
   * 检查当前 Token 是否已过期或即将在给定的安全时间(默认 30 秒)内过期.
   */
  isTokenExpiredOrNearExpiry(safetySkewMs = 30_000): boolean {
    const row = this.readCredentials();
    if (!row || !row.access_token) return true;
    if (row.expires_at_ms === null) return false;
    return row.expires_at_ms <= Date.now() + safetySkewMs;
  }

  /**
   * 获取当前服务的 OAuth 状态机视图:
   * 1. 若回环端口正在监听等待授权回调, 状态为 'authorizing'.
   * 2. 若拥有与当前服务地址匹配的 access_token, 状态为 'authorized'.
   * 3. 否则为 'required'.
   */
  getStatus(): McpOAuthStatus {
    if (this.pendingLogin) {
      return {
        status: 'authorizing',
        ...(this.pendingLogin.authorizationUrl
          ? { authorizationUrl: this.pendingLogin.authorizationUrl.toString() }
          : {}),
        expiresAtMs: null,
        updatedAt: this.pendingLogin.startedAt,
      };
    }

    const row = this.readCredentials();
    if (row && row.access_token) {
      return {
        status: 'authorized',
        expiresAtMs: row.expires_at_ms,
        updatedAt: row.updated_at,
      };
    }

    return {
      status: 'required',
      expiresAtMs: null,
      updatedAt: row?.updated_at ?? 0,
    };
  }

  /**
   * 单飞续期锁: 若当前 Token 即将失效且存在 Refresh Token, 直接通过 SDK refreshAuthorization 续期.
   * 并发调用时共用同一个 Promise; 单个调用方取消只退出自身等待, 不打断其他调用方共用的刷新请求.
   */
  async ensureFreshToken(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const credentials = this.readCredentials();
    const refreshToken = credentials?.refresh_token;
    if (!credentials || !refreshToken || !this.isTokenExpiredOrNearExpiry()) {
      return;
    }
    if (isStoredClientSecretExpired(credentials)) {
      logging({
        level: 'warn',
        target: 'mcp',
        event: 'mcp.oauth.client_secret_expired',
        message: `Skipping OAuth refresh for server "${this.serverName}" because stored client_secret has expired.`,
      });
      return;
    }

    if (this.pendingTokenRefresh) {
      await waitForPromise(this.pendingTokenRefresh, signal);
      return;
    }

    const isCurrentRefresh = () => {
      const current = this.readCredentials();
      return current?.version === credentials.version && current.refresh_token === refreshToken;
    };

    const refreshPromise = (async () => {
      try {
        const { discoverOAuthServerInfo, refreshAuthorization, selectResourceURL } =
          await import('@modelcontextprotocol/sdk/client/auth.js');
        const { InvalidGrantError } = await import('@modelcontextprotocol/sdk/server/auth/errors.js');

        const discovery = await discoverOAuthServerInfo(this.serverUrl);
        const resource = await selectResourceURL(this.serverUrl, DEFAULT_RESOURCE_PROVIDER, discovery.resourceMetadata);
        if (!isCurrentRefresh()) return;

        try {
          const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
            metadata: discovery.authorizationServerMetadata,
            clientInformation: buildClientInformationFromRow(credentials),
            refreshToken,
            resource,
          });
          if (isCurrentRefresh()) {
            await this.saveTokens(tokens, credentials.version);
          }
        } catch (error) {
          // 仅当本次使用的 refresh_token 与版本号仍未失效时才清除本机 Token, 防止迟到报错误删新登录凭据.
          if (error instanceof InvalidGrantError && isCurrentRefresh()) {
            this.credentialsRepo.clearTokens(this.serverName, Date.now());
            return;
          }
          throw error;
        }
      } catch (error) {
        logging({
          level: 'warn',
          target: 'mcp',
          event: 'mcp.oauth.proactive_refresh_failed',
          message: `Proactive OAuth refresh failed for server "${this.serverName}": ${(error as Error).message}`,
          error,
        });
      }
    })();

    this.pendingTokenRefresh = refreshPromise;
    try {
      await waitForPromise(refreshPromise, signal);
    } finally {
      if (this.pendingTokenRefresh === refreshPromise) {
        this.pendingTokenRefresh = undefined;
      }
    }
  }
}
