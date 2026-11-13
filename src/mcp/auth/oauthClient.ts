import { randomUUID } from 'node:crypto';
import { logging } from '@ema-agent/logging';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpOAuthCredentialsRepo } from '@ema-agent/storage';
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
   * 若本地数据库未曾保存过 client_id 则返回 undefined, SDK 会尝试动态注册.
   */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const row = this.credentialsRepo.findByServerId(this.serverId);
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
   * 若当前没有 Token 则返回 undefined.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    const row = this.credentialsRepo.findByServerId(this.serverId);
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
   * 采用版本号条件更新. 若因用户清除授权或重新登录导致版本号不一致,
   * 则安全丢弃迟到的更新结果.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const current = this.credentialsRepo.findByServerId(this.serverId);
    if (!current) {
      throw new Error(`Cannot save OAuth tokens: client registration record not found for server ID "${this.serverId}".`);
    }

    const expiresAtMs =
      tokens.expires_in !== undefined && tokens.expires_in !== null
        ? Date.now() + Math.floor(Number(tokens.expires_in)) * 1000
        : null;

    const updated = this.credentialsRepo.updateTokensIfVersionMatches({
      mcpServerId: this.serverId,
      version: current.version,
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
        message: `Stale OAuth token update rejected by optimistic lock. Server ID: ${this.serverId}, version was ${current.version}.`,
      });
    }
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
   * 若之前已有未完成的登录任务, 先执行中止并等待旧端口物理清理完毕, 保证端口与状态串行确定.
   */
  async attachPendingLogin(pending: McpOAuthPendingLogin): Promise<void> {
    if (this.pendingLogin && this.pendingLogin !== pending) {
      const oldTask = this.pendingLogin;
      this.pendingLogin = undefined;
      oldTask.abortController.abort();
      await oldTask.cleanup();
    }
    this.pendingLogin = pending;
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
    const row = this.credentialsRepo.findByServerId(this.serverId);
    if (!row || !row.access_token) return true;
    if (row.expires_at_ms === null) return false;
    return row.expires_at_ms <= Date.now() + safetySkewMs;
  }

  /**
   * 检查当前是否有可用于续期的 Refresh Token.
   */
  hasRefreshToken(): boolean {
    const row = this.credentialsRepo.findByServerId(this.serverId);
    return Boolean(row?.refresh_token);
  }

  /**
   * 获取当前服务的 OAuth 状态机视图:
   * 1. 若回环端口正在监听等待授权回调, 状态为 'authorizing'.
   * 2. 若拥有有效 access_token, 状态为 'authorized'.
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

    const row = this.credentialsRepo.findByServerId(this.serverId);
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
   * 单飞续期锁: 若当前 Token 即将失效且存在 Refresh Token, 触发主动续期.
   * 并发调用时共用同一个 Promise, 消除重复网络请求与并发竞争.
   */
  async ensureFreshToken(signal?: AbortSignal): Promise<void> {
    if (!this.isTokenExpiredOrNearExpiry() || !this.hasRefreshToken()) {
      return;
    }

    if (this.pendingTokenRefresh) {
      await this.pendingTokenRefresh;
      return;
    }

    const refreshPromise = (async () => {
      try {
        if (signal?.aborted) return;
        const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
        await auth(this, { serverUrl: this.serverUrl });
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
      await refreshPromise;
    } finally {
      if (this.pendingTokenRefresh === refreshPromise) {
        this.pendingTokenRefresh = undefined;
      }
    }
  }
}
