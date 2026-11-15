import type { SqliteDb } from '../../database/database.js';

export interface McpOAuthCredentialsRow {
  mcp_server_name: string;
  server_url: string;
  client_id: string;
  client_secret: string | null;
  /** 动态注册协商的 Token 端点客户端认证方式, 如 client_secret_basic / client_secret_post / none; null 表示未指定. */
  token_endpoint_auth_method: string | null;
  /** 动态注册时登记在服务端的回跳 URI 列表 JSON 字符串; null 表示尚未记录登记过的回跳地址. */
  redirect_uris_json: string | null;
  /** client_secret 过期毫秒时间戳; null 表示未过期限制或未知. */
  client_secret_expires_at_ms: number | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at_ms: number | null;
  version: number;
  updated_at: number;
}

export interface McpOAuthCredentialsUpsert {
  mcpServerName: string;
  serverUrl: string;
  clientId: string;
  clientSecret?: string | null;
  tokenEndpointAuthMethod?: string | null;
  redirectUrisJson?: string | null;
  clientSecretExpiresAtMs?: number | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAtMs?: number | null;
  updatedAt: number;
}

export interface McpOAuthTokenUpdate {
  mcpServerName: string;
  version: number;
  accessToken: string | null;
  refreshToken?: string | null;
  expiresAtMs?: number | null;
  updatedAt: number;
}

/**
 * MCP OAuth 凭据仓库.
 *
 * 在 profile.db 中持久化 OAuth 客户端注册信息与访问/刷新 Token.
 * 按唯一的 mcp_server_name 关联对应 MCP 服务, 采用 version 乐观并发控制防止迟到的旧续期覆盖新凭据.
 */
export class McpOAuthCredentialsRepo {
  constructor(private readonly db: SqliteDb) {}

  findByServerName(mcpServerName: string): McpOAuthCredentialsRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM mcp_oauth_credentials WHERE mcp_server_name = ?')
        .get(mcpServerName) as McpOAuthCredentialsRow | undefined) ?? null
    );
  }

  findByServerUrl(serverUrl: string): McpOAuthCredentialsRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM mcp_oauth_credentials WHERE server_url = ?')
        .get(serverUrl) as McpOAuthCredentialsRow | undefined) ?? null
    );
  }

  /**
   * 保存客户端登记信息与可选的初始 Token.
   * 若记录不存在, 写入初始记录且 version = 1.
   * 若记录已存在, 更新客户端信息并自增版本号.
   */
  saveInitialOrClient(upsert: McpOAuthCredentialsUpsert): McpOAuthCredentialsRow {
    const existing = this.findByServerName(upsert.mcpServerName);
    if (!existing) {
      this.db
        .prepare(`
          INSERT INTO mcp_oauth_credentials (
            mcp_server_name, server_url, client_id, client_secret,
            token_endpoint_auth_method, redirect_uris_json, client_secret_expires_at_ms,
            access_token, refresh_token, expires_at_ms, version, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `)
        .run(
          upsert.mcpServerName,
          upsert.serverUrl,
          upsert.clientId,
          upsert.clientSecret ?? null,
          upsert.tokenEndpointAuthMethod ?? null,
          upsert.redirectUrisJson ?? null,
          upsert.clientSecretExpiresAtMs ?? null,
          upsert.accessToken ?? null,
          upsert.refreshToken ?? null,
          upsert.expiresAtMs ?? null,
          upsert.updatedAt,
        );
      return this.findByServerName(upsert.mcpServerName)!;
    }

    // 仅在同一服务端地址与同一 client_id 下保留未显式覆盖的凭据与注册元数据,
    // 换新地址或重新动态注册时清空旧 Token/认证元数据, 避免旧注册串库留存.
    const sameClient =
      existing.server_url === upsert.serverUrl && existing.client_id === upsert.clientId;
    const nextClientSecret = upsert.clientSecret !== undefined
      ? upsert.clientSecret
      : (sameClient ? existing.client_secret : null);
    const nextTokenEndpointAuthMethod = upsert.tokenEndpointAuthMethod !== undefined
      ? upsert.tokenEndpointAuthMethod
      : (sameClient ? existing.token_endpoint_auth_method : null);
    const nextRedirectUrisJson = upsert.redirectUrisJson !== undefined
      ? upsert.redirectUrisJson
      : (sameClient ? existing.redirect_uris_json : null);
    const nextClientSecretExpiresAtMs = upsert.clientSecretExpiresAtMs !== undefined
      ? upsert.clientSecretExpiresAtMs
      : (sameClient ? existing.client_secret_expires_at_ms : null);
    const nextAccessToken = upsert.accessToken !== undefined
      ? upsert.accessToken
      : (sameClient ? existing.access_token : null);
    const nextRefreshToken = upsert.refreshToken !== undefined
      ? upsert.refreshToken
      : (sameClient ? existing.refresh_token : null);
    const nextExpiresAtMs = upsert.expiresAtMs !== undefined
      ? upsert.expiresAtMs
      : (sameClient ? existing.expires_at_ms : null);

    this.db
      .prepare(`
        UPDATE mcp_oauth_credentials
        SET server_url = ?,
            client_id = ?,
            client_secret = ?,
            token_endpoint_auth_method = ?,
            redirect_uris_json = ?,
            client_secret_expires_at_ms = ?,
            access_token = ?,
            refresh_token = ?,
            expires_at_ms = ?,
            version = version + 1,
            updated_at = ?
        WHERE mcp_server_name = ?
      `)
      .run(
        upsert.serverUrl,
        upsert.clientId,
        nextClientSecret,
        nextTokenEndpointAuthMethod,
        nextRedirectUrisJson,
        nextClientSecretExpiresAtMs,
        nextAccessToken,
        nextRefreshToken,
        nextExpiresAtMs,
        upsert.updatedAt,
        upsert.mcpServerName,
      );
    return this.findByServerName(upsert.mcpServerName)!;
  }

  /**
   * 按期望的 version 条件更新 Token.
   * 若记录已被其他并发操作(例如登出或新登录)改动, SQL 更新 0 行并返回 false, 调用方安全丢弃过期 Token.
   */
  updateTokensIfVersionMatches(params: McpOAuthTokenUpdate): boolean {
    const result = this.db
      .prepare(`
        UPDATE mcp_oauth_credentials
        SET access_token = ?,
            refresh_token = COALESCE(?, refresh_token),
            expires_at_ms = ?,
            version = version + 1,
            updated_at = ?
        WHERE mcp_server_name = ? AND version = ?
      `)
      .run(
        params.accessToken,
        params.refreshToken ?? null,
        params.expiresAtMs ?? null,
        params.updatedAt,
        params.mcpServerName,
        params.version,
      );
    return result.changes > 0;
  }

  /**
   * 清除本机 OAuth Token(access_token, refresh_token, expires_at_ms).
   * 保留客户端注册元数据(client_id, client_secret, 认证方式, 回跳地址与密钥过期时间).
   * 自增 version 使尚未完成的异步旧续期失效.
   */
  clearTokens(mcpServerName: string, updatedAt: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE mcp_oauth_credentials
        SET access_token = NULL,
            refresh_token = NULL,
            expires_at_ms = NULL,
            version = version + 1,
            updated_at = ?
        WHERE mcp_server_name = ?
      `)
      .run(updatedAt, mcpServerName);
    return result.changes > 0;
  }

  deleteByServerName(mcpServerName: string): void {
    this.db.prepare('DELETE FROM mcp_oauth_credentials WHERE mcp_server_name = ?').run(mcpServerName);
  }
}
