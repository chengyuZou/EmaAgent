import { randomUUID } from 'node:crypto';
import { logging } from '@ema-agent/logging';
import { waitForPromise } from '../connections/requestControl.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpOAuthCredentialsRepo, McpOAuthCredentialsRow } from '@ema-agent/storage';
import type { McpOAuthPendingLogin, McpOAuthStatus } from './types.js';

/**
 * 针对单个 MCP HTTP 服务的 OAuthClientProvider 实现.
 *
 * 桥接 @modelcontextprotocol/sdk 的 OAuth 授权层与 Ema 的 SQLite profile.db 存储.
 * 负责客户端注册信息读取, Token 存取(带乐观并发控制), 回环授权流程状态以及并发刷新排队锁.
 */
export class McpOAuthClient implements OAuthClientProvider {
  /** 当前正在进行中的回环端口登录任务. */
  private pendingLogin?: McpOAuthPendingLogin;
  /** 当前正在排队或执行中的 Token 续期 Promise, 避免高并发调用工具时向鉴权服务器重复请求. */
  private pendingTokenRefresh?: Promise<void>;

  constructor(
    readonly serverId: string,
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
   * 按 serverId 读取并核对服务端 URL 一致的 OAuth 凭据行.
   */
  private readCredentials(): McpOAuthCredentialsRow | null {
    const row = this.credentialsRepo.findByServerId(this.serverId);
    return row?.server_url === this.serverUrl ? row : null;
  }

  /**
   * 返回当前交互式授权回调 URL.
   * 当没有处于进行中的浏览器登录任务时返回 undefined.
   */
  get redirectUrl(): string | undefined {
    return this.pendingLogin?.redirectUri;
  }

  /**
   * OAuth 客户端元数据, 提供给动态客户端注册与鉴权流程.
   */
  get clientMetadata(): OAuthClientMetadata {
    const redirectUris = this.pendingLogin?.redirectUri
      ? [this.pendingLogin.redirectUri]
      : ['http://127.0.0.1/oauth/callback'];

    return {
      client_name: 'EmaAgent',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  /**
   * 返回本次授权请求的 state 参数.
   * 优先使用活跃登录任务中的 state, 无任务时返回生成的随机 UUID.
   */
  state(): string {
    return this.pendingLogin?.state ?? randomUUID();
  }

  /**
   * 读取已在服务端登记的客户端信息.
   * 若本地数据库未曾保存过 client_id 或地址不匹配则返回 undefined, SDK 会尝试动态注册.
   */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const row = this.readCredentials();
    if (!row || !row.client_id) {
      return undefined;
    }
    return {
      client_id: row.client_id,
      client_secret: row.client_secret ?? undefined,
    };
  }

  /**
   * 保存动态注册成功后服务端返回的客户端登记信息.
   */
  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.credentialsRepo.saveInitialOrClient({
      mcpServerId: this.serverId,
      serverUrl: this.serverUrl,
      clientId: info.client_id,
      clientSecret: info.client_secret ?? null,
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
      throw new Error(`Cannot save OAuth tokens: client registration record not found for server ID "${this.serverId}".`);
    }
    const targetVersion = expectedVersion ?? current.version;

    const expiresAtMs =
      tokens.expires_in !== undefined && tokens.expires_in !== null
        ? Date.now() + Math.floor(Number(tokens.expires_in)) * 1000
        : null;

    const updated = this.credentialsRepo.updateTokensIfVersionMatches({
      mcpServerId: this.serverId,
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
        message: `Stale OAuth token update rejected by optimistic lock. Server ID: ${this.serverId}, expected version ${targetVersion}, current version ${current.version}.`,
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
      clientMetadata: this.clientMetadata,
      state: () => login.state,
      clientInformation: () => this.clientInformation(),
      tokens: () => this.tokens(),
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
        await this.saveClientInformation(info);
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

  /**
   * 保存 PKCE Code Verifier 到内存任务中.
   */
  saveCodeVerifier(codeVerifier: string): void {
    if (this.pendingLogin) {
      this.pendingLogin.codeVerifier = codeVerifier;
    }
  }

  /**
   * 从内存任务中读取 PKCE Code Verifier 用于 Token 兑换.
   */
  codeVerifier(): string {
    if (!this.pendingLogin?.codeVerifier) {
      throw new Error('No active OAuth login task or missing PKCE code verifier.');
    }
    return this.pendingLogin.codeVerifier;
  }

  /**
   * 暂存服务端生成的授权跳转 URL, 供桌面端通过默认浏览器打开.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.pendingLogin) {
      this.pendingLogin.authorizationUrl = authorizationUrl;
    }
  }

  /**
   * 服务端指示凭据失效时的主动清理回调.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'tokens' || scope === 'all') {
      this.credentialsRepo.clearTokens(this.serverId, Date.now());
    }
    if (scope === 'client' || scope === 'all') {
      this.credentialsRepo.deleteByServerId(this.serverId);
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
   * 检查当前是否有可用于续期的 Refresh Token.
   */
  hasRefreshToken(): boolean {
    const row = this.readCredentials();
    return Boolean(row?.refresh_token);
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
        expiresAtMs: null,
        updatedAt: Date.now(),
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
        const resource = await selectResourceURL(this.serverUrl, this, discovery.resourceMetadata);
        if (!isCurrentRefresh()) return;

        try {
          const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
            metadata: discovery.authorizationServerMetadata,
            clientInformation: {
              client_id: credentials.client_id,
              client_secret: credentials.client_secret ?? undefined,
            },
            refreshToken,
            resource,
          });
          if (isCurrentRefresh()) {
            await this.saveTokens(tokens, credentials.version);
          }
        } catch (error) {
          // 仅当本次使用的 refresh_token 与版本号仍未失效时才清除本机 Token, 防止迟到报错误删新登录凭据.
          if (error instanceof InvalidGrantError && isCurrentRefresh()) {
            this.credentialsRepo.clearTokens(this.serverId, Date.now());
            return;
          }
          throw error;
        }
      } catch (error) {
        logging({
          level: 'warn',
          target: 'mcp',
          event: 'mcp.oauth.proactive_refresh_failed',
          message: `Proactive OAuth refresh failed for server ID "${this.serverId}": ${(error as Error).message}`,
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
