import type { SqliteDb } from '../../database/database.js';

export interface McpOAuthCredentialsRow {
  mcp_server_name: string;
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
  mcpServerName: string;
  serverUrl: string;
  clientId: string;
  clientSecret?: string | null;
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
            access_token, refresh_token, expires_at_ms, version, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        `)
        .run(
          upsert.mcpServerName,
          upsert.serverUrl,
          upsert.clientId,
          upsert.clientSecret ?? null,
          upsert.accessToken ?? null,
          upsert.refreshToken ?? null,
          upsert.expiresAtMs ?? null,
          upsert.updatedAt,
        );
      return this.findByServerName(upsert.mcpServerName)!;
    }

    // 仅在同一服务端地址与同一 client_id 下保留原有 Token/Secret,
    // 换新地址或重新动态注册时清空旧 Token, 避免旧地址凭据串库留存.
    const sameClient =
      existing.server_url === upsert.serverUrl && existing.client_id === upsert.clientId;

    this.db
      .prepare(`
        UPDATE mcp_oauth_credentials
        SET server_url = ?,
            client_id = ?,
            client_secret = ?,
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
        upsert.clientSecret ?? (sameClient ? existing.client_secret : null),
        upsert.accessToken ?? (sameClient ? existing.access_token : null),
        upsert.refreshToken ?? (sameClient ? existing.refresh_token : null),
        upsert.expiresAtMs ?? (sameClient ? existing.expires_at_ms : null),
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
   * 保留 client_id 与 client_secret, 使后续再次登录无需重复向服务端进行动态客户端注册.
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
