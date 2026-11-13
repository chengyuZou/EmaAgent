import type { McpOAuthCredentialsRepo } from '@ema-agent/storage';
import { McpOAuthClient } from './oauthClient.js';
import { startOAuthLogin } from './oauthLogin.js';
import type { McpOAuthLoginResult, McpOAuthStatus } from './types.js';

export interface StartOAuthOptions {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly timeoutMs?: number;
}

/**
 * MCP OAuth 领域业务服务.
 * 对标 McpMarketService, 统一协调管理所有 MCP 服务的 OAuth Client 实例, 浏览器交互授权与凭据状态.
 */
export class McpOAuthService {
  /**
   * 服务级 OAuth 客户端单例缓存, 键为 MCP 服务的持久化唯一 ID (serverId).
   */
  private readonly oauthClientsByServerId = new Map<string, McpOAuthClient>();

  constructor(private readonly credentialsRepo: McpOAuthCredentialsRepo) {}

  /**
   * 获取或懒加载指定服务的 McpOAuthClient 单例.
   */
  getClient(serverId: string, serverUrl: string): McpOAuthClient {
    let client = this.oauthClientsByServerId.get(serverId);
    if (!client) {
      client = new McpOAuthClient(serverId, serverUrl, this.credentialsRepo);
      this.oauthClientsByServerId.set(serverId, client);
    }
    return client;
  }

  /**
   * 发起一次 OAuth 交互式授权.
   * 若之前已有未完成的授权任务, 底层会自动关闭旧端口并中止旧任务.
   */
  async startLogin(options: StartOAuthOptions): Promise<McpOAuthLoginResult> {
    const client = this.getClient(options.id, options.url);
    return startOAuthLogin({
      serverId: options.id,
      serverName: options.name,
      serverUrl: options.url,
      client,
      timeoutMs: options.timeoutMs,
    });
  }

  /**
   * 取消指定服务正在进行中的 OAuth 授权任务, 并关闭回环监听端口.
   */
  async cancelLogin(serverId: string): Promise<void> {
    const client = this.oauthClientsByServerId.get(serverId);
    if (client) {
      await client.cancelPendingLogin();
    }
  }

  /**
   * 清除指定服务的 OAuth Token (保留 client_id 注册信息), 并取消进行中的授权.
   */
  async clearTokens(serverId: string): Promise<void> {
    await this.cancelLogin(serverId);
    this.credentialsRepo.clearTokens(serverId, Date.now());
  }

  /**
   * 查询指定服务的当前 OAuth 状态.
   * 若 authType 为 'none' 则返回 null.
   */
  getStatus(serverId: string, authType: 'none' | 'oauth'): McpOAuthStatus | null {
    if (authType === 'none') {
      return null;
    }

    const client = this.oauthClientsByServerId.get(serverId);
    if (client) {
      return client.getStatus();
    }

    const row = this.credentialsRepo.findByServerId(serverId);
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
   * 在调用工具前单飞续期 Token.
   */
  async ensureFreshToken(serverId: string, serverUrl: string, signal?: AbortSignal): Promise<void> {
    const client = this.getClient(serverId, serverUrl);
    await client.ensureFreshToken(signal);
  }

  /**
   * 移除并清理指定服务的客户端缓存.
   */
  async removeClient(serverId: string): Promise<void> {
    const client = this.oauthClientsByServerId.get(serverId);
    if (client) {
      await client.cancelPendingLogin();
      this.oauthClientsByServerId.delete(serverId);
    }
  }
}
