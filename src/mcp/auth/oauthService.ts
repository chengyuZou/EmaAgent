import type { McpOAuthCredentialsRepo } from '@ema-agent/storage';
import { McpOAuthClient } from './oauthClient.js';
import { startOAuthLogin } from './oauthLogin.js';
import type { McpOAuthLoginResult, McpOAuthStatus } from './types.js';

export interface StartOAuthOptions {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly timeoutMs?: number;
}

/**
 * MCP OAuth 领域业务服务.
 * 对标 McpMarketService, 统一协调管理所有 MCP 服务的 OAuth Client 实例, 浏览器交互授权与凭据状态.
 */
export class McpOAuthService {
  /**
   * 服务级 OAuth 客户端单例缓存, 键为唯一的 MCP 服务名 (serverName).
   */
  private readonly oauthClientsByServerName = new Map<string, McpOAuthClient>();

  constructor(private readonly credentialsRepo: McpOAuthCredentialsRepo) {}

  /**
   * 获取或懒加载指定服务的 McpOAuthClient 单例.
   * 若服务 URL 已变更, 中止旧客户端上的待完成登录并按新地址重建.
   */
  getClient(serverName: string, serverUrl: string): McpOAuthClient {
    let client = this.oauthClientsByServerName.get(serverName);
    if (!client || client.serverUrl !== serverUrl) {
      void client?.cancelPendingLogin();
      client = new McpOAuthClient(serverName, serverUrl, this.credentialsRepo);
      this.oauthClientsByServerName.set(serverName, client);
    }
    return client;
  }

  /**
   * 发起一次 OAuth 交互式授权.
   * 若之前已有未完成的授权任务, 底层会自动关闭旧端口并中止旧任务.
   */
  async startLogin(options: StartOAuthOptions): Promise<McpOAuthLoginResult> {
    const client = this.getClient(options.serverName, options.serverUrl);
    return startOAuthLogin({
      serverName: options.serverName,
      client,
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * 取消指定服务正在进行中的 OAuth 授权任务, 并关闭回环监听端口.
   */
  async cancelLogin(serverName: string): Promise<void> {
    const client = this.oauthClientsByServerName.get(serverName);
    if (client) {
      await client.cancelPendingLogin();
    }
  }

  /**
   * 清除指定服务的 OAuth Token (保留 client_id 注册信息), 并取消进行中的授权.
   */
  async clearTokens(serverName: string): Promise<void> {
    await this.cancelLogin(serverName);
    this.credentialsRepo.clearTokens(serverName, Date.now());
  }

  /**
   * 查询指定服务的当前 OAuth 状态.
   * 若 authType 为 'none' 则返回 null; 若传入 serverUrl 则核对是否与已存储凭据地址一致.
   */
  getStatus(serverName: string, authType: 'none' | 'oauth', serverUrl?: string): McpOAuthStatus | null {
    if (authType === 'none') {
      return null;
    }

    const client = this.oauthClientsByServerName.get(serverName);
    if (client && (!serverUrl || client.serverUrl === serverUrl)) {
      return client.getStatus();
    }

    const row = this.credentialsRepo.findByServerName(serverName);
    const matchesUrl = !serverUrl || (row !== null && row.server_url === serverUrl);
    if (row && matchesUrl && row.access_token) {
      return {
        status: 'authorized',
        expiresAtMs: row.expires_at_ms,
        updatedAt: row.updated_at,
      };
    }

    return {
      status: 'required',
      expiresAtMs: null,
      updatedAt: matchesUrl ? (row?.updated_at ?? 0) : 0,
    };
  }

  /**
   * 在调用工具前单飞续期 Token.
   */
  async ensureFreshToken(serverName: string, serverUrl: string, signal?: AbortSignal): Promise<void> {
    const client = this.getClient(serverName, serverUrl);
    await client.ensureFreshToken(signal);
  }

  /**
   * 移除并清理指定服务的客户端缓存.
   */
  async removeClient(serverName: string): Promise<void> {
    const client = this.oauthClientsByServerName.get(serverName);
    if (client) {
      await client.cancelPendingLogin();
      this.oauthClientsByServerName.delete(serverName);
    }
  }
}
