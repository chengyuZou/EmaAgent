import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, McpOAuthCredentialsRepo, McpServersRepo } from '../../index.js';

describe('MCP OAuth 凭据持久化与乐观锁', () => {
  let database: Database;
  let serversRepo: McpServersRepo;
  let credentialsRepo: McpOAuthCredentialsRepo;

  beforeEach(async () => {
    database = new Database({ memory: true, kind: 'profile' });
    await database.migrate();
    serversRepo = new McpServersRepo(database.sqlite);
    credentialsRepo = new McpOAuthCredentialsRepo(database.sqlite);

    // 预先插入关联的 MCP Server 记录.
    serversRepo.insert({
      id: 'srv-notion',
      name: 'notion',
      install_source: 'manual',
      market_entry_id: null,
      config_json: JSON.stringify({ type: 'http', url: 'https://mcp.notion.com/mcp' }),
      tools_cache: null,
      enabled: 1,
      installed_at: 1000,
    });
  });

  afterEach(() => database.close());

  it('保存客户端信息与初始 Token, 按 Server ID 和 URL 查询', () => {
    const saved = credentialsRepo.saveInitialOrClient({
      mcpServerId: 'srv-notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-123',
      clientSecret: 'secret-456',
      accessToken: 'token-initial',
      refreshToken: 'refresh-initial',
      expiresAtMs: 2000,
      updatedAt: 1000,
    });

    expect(saved.version).toBe(1);
    expect(saved.client_id).toBe('client-123');
    expect(saved.client_secret).toBe('secret-456');
    expect(saved.access_token).toBe('token-initial');

    const byId = credentialsRepo.findByServerId('srv-notion');
    expect(byId).toEqual(saved);

    const byUrl = credentialsRepo.findByServerUrl('https://mcp.notion.com/mcp');
    expect(byUrl).toEqual(saved);
  });

  it('版本匹配时成功更新 Token 并自增版本号', () => {
    credentialsRepo.saveInitialOrClient({
      mcpServerId: 'srv-notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-123',
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      expiresAtMs: 2000,
      updatedAt: 1000,
    });

    const updated = credentialsRepo.updateTokensIfVersionMatches({
      mcpServerId: 'srv-notion',
      version: 1,
      accessToken: 'token-2',
      refreshToken: 'refresh-2',
      expiresAtMs: 4000,
      updatedAt: 2000,
    });

    expect(updated).toBe(true);

    const row = credentialsRepo.findByServerId('srv-notion');
    expect(row?.version).toBe(2);
    expect(row?.access_token).toBe('token-2');
    expect(row?.refresh_token).toBe('refresh-2');
    expect(row?.expires_at_ms).toBe(4000);
  });

  it('版本过旧时拒绝更新 Token, 防止迟到的异步续期覆盖新登录', () => {
    credentialsRepo.saveInitialOrClient({
      mcpServerId: 'srv-notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-123',
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      expiresAtMs: 2000,
      updatedAt: 1000,
    });

    // 模拟另一操作(如用户清除授权或重新授权)使版本升到了 2
    credentialsRepo.clearTokens('srv-notion', 1500);
    const rowAfterClear = credentialsRepo.findByServerId('srv-notion');
    expect(rowAfterClear?.version).toBe(2);

    // 迟到的旧续期请求仍按 version = 1 尝试写库, 应被拦截
    const staleUpdated = credentialsRepo.updateTokensIfVersionMatches({
      mcpServerId: 'srv-notion',
      version: 1,
      accessToken: 'stale-token',
      refreshToken: 'stale-refresh',
      expiresAtMs: 9999,
      updatedAt: 2000,
    });

    expect(staleUpdated).toBe(false);

    // 数据库保持清除后的状态, Token 不被污染
    const current = credentialsRepo.findByServerId('srv-notion');
    expect(current?.version).toBe(2);
    expect(current?.access_token).toBeNull();
    expect(current?.refresh_token).toBeNull();
  });

  it('清除授权时清空 Token 并自增版本号, 保留客户端注册信息', () => {
    credentialsRepo.saveInitialOrClient({
      mcpServerId: 'srv-notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-permanent',
      clientSecret: 'secret-permanent',
      accessToken: 'token-acc-1',
      refreshToken: 'refresh-acc-1',
      expiresAtMs: 3000,
      updatedAt: 1000,
    });

    const cleared = credentialsRepo.clearTokens('srv-notion', 2000);
    expect(cleared).toBe(true);

    const row = credentialsRepo.findByServerId('srv-notion');
    expect(row?.version).toBe(2);
    expect(row?.access_token).toBeNull();
    expect(row?.refresh_token).toBeNull();
    expect(row?.expires_at_ms).toBeNull();
    // 客户端登记依然保留, 下次重新登录免去动态注册
    expect(row?.client_id).toBe('client-permanent');
    expect(row?.client_secret).toBe('secret-permanent');
  });

  it('父级 mcp_servers 记录删除时级联删除对应的 OAuth 凭据', () => {
    credentialsRepo.saveInitialOrClient({
      mcpServerId: 'srv-notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-123',
      updatedAt: 1000,
    });

    expect(credentialsRepo.findByServerId('srv-notion')).not.toBeNull();

    serversRepo.deleteById('srv-notion');
    expect(credentialsRepo.findByServerId('srv-notion')).toBeNull();
  });
});
