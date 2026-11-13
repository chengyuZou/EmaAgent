import type { SqliteDb } from '../../database/database.js';

export interface McpOAuthCredentialsRow {
  mcp_server_id: string;
  server_url: string;
  client_id: string;
  client_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at_ms: number | null;
  version: number;
  updated_at: number;
}

export interface McpOAuthCredentialsUpsert {
  mcpServerId: string;
  serverUrl: string;
  clientId: string;
  clientSecret?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAtMs?: number | null;
  updatedAt: number;
}

export interface McpOAuthTokenUpdate {
  mcpServerId: string;
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
 * 采用基于 version 字段的乐观并发控制, 避免迟到的异步 Token 续期覆盖较新的用户登录或清空操作.
 */
export class McpOAuthCredentialsRepo {
  constructor(private readonly db: SqliteDb) {}

  findByServerId(mcpServerId: string): McpOAuthCredentialsRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM mcp_oauth_credentials WHERE mcp_server_id = ?')
        .get(mcpServerId) as McpOAuthCredentialsRow | undefined) ?? null
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
    const existing = this.findByServerId(upsert.mcpServerId);
    if (!existing) {
      this.db
        .prepare(`
          INSERT INTO mcp_oauth_credentials (
            mcp_server_id, server_url, client_id, client_secret,
            access_token, refresh_token, expires_at_ms, version, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        `)
        .run(
          upsert.mcpServerId,
          upsert.serverUrl,
          upsert.clientId,
          upsert.clientSecret ?? null,
          upsert.accessToken ?? null,
          upsert.refreshToken ?? null,
          upsert.expiresAtMs ?? null,
          upsert.updatedAt,
        );
      return this.findByServerId(upsert.mcpServerId)!;
    }

    this.db
      .prepare(`
        UPDATE mcp_oauth_credentials
        SET server_url = ?,
            client_id = ?,
            client_secret = COALESCE(?, client_secret),
            access_token = COALESCE(?, access_token),
            refresh_token = COALESCE(?, refresh_token),
            expires_at_ms = COALESCE(?, expires_at_ms),
            version = version + 1,
            updated_at = ?
        WHERE mcp_server_id = ?
      `)
      .run(
        upsert.serverUrl,
        upsert.clientId,
        upsert.clientSecret ?? null,
        upsert.accessToken ?? null,
        upsert.refreshToken ?? null,
        upsert.expiresAtMs ?? null,
        upsert.updatedAt,
        upsert.mcpServerId,
      );
    return this.findByServerId(upsert.mcpServerId)!;
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
        WHERE mcp_server_id = ? AND version = ?
      `)
      .run(
        params.accessToken,
        params.refreshToken ?? null,
        params.expiresAtMs ?? null,
        params.updatedAt,
        params.mcpServerId,
        params.version,
      );
    return result.changes > 0;
  }

  /**
   * 清除本机 OAuth Token(access_token, refresh_token, expires_at_ms).
   * 保留 client_id 与 client_secret, 使后续再次登录无需重复向服务端进行动态客户端注册.
   * 自增 version 使尚未完成的异步旧续期失效.
   */
  clearTokens(mcpServerId: string, updatedAt: number): boolean {
    const result = this.db
      .prepare(`
        UPDATE mcp_oauth_credentials
        SET access_token = NULL,
            refresh_token = NULL,
            expires_at_ms = NULL,
            version = version + 1,
            updated_at = ?
        WHERE mcp_server_id = ?
      `)
      .run(updatedAt, mcpServerId);
    return result.changes > 0;
  }

  deleteByServerId(mcpServerId: string): void {
    this.db.prepare('DELETE FROM mcp_oauth_credentials WHERE mcp_server_id = ?').run(mcpServerId);
  }
}
