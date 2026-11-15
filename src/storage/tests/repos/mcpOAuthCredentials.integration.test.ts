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

  it('保存客户端信息与初始 Token, 按 Server 名称和 URL 查询', () => {
    const saved = credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
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

    const byName = credentialsRepo.findByServerName('notion');
    expect(byName).toEqual(saved);

    const byUrl = credentialsRepo.findByServerUrl('https://mcp.notion.com/mcp');
    expect(byUrl).toEqual(saved);
  });

  it('版本匹配时成功更新 Token 并自增版本号', () => {
    credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-123',
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      expiresAtMs: 2000,
      updatedAt: 1000,
    });

    const updated = credentialsRepo.updateTokensIfVersionMatches({
      mcpServerName: 'notion',
      version: 1,
      accessToken: 'token-2',
      refreshToken: 'refresh-2',
      expiresAtMs: 4000,
      updatedAt: 2000,
    });

    expect(updated).toBe(true);

    const row = credentialsRepo.findByServerName('notion');
    expect(row?.version).toBe(2);
    expect(row?.access_token).toBe('token-2');
    expect(row?.refresh_token).toBe('refresh-2');
    expect(row?.expires_at_ms).toBe(4000);
  });

  it('版本过旧时拒绝更新 Token, 防止迟到的异步续期覆盖新登录', () => {
    credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-123',
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      expiresAtMs: 2000,
      updatedAt: 1000,
    });

    // 模拟另一操作(如用户清除授权或重新授权)使版本升到了 2
    credentialsRepo.clearTokens('notion', 1500);
    const rowAfterClear = credentialsRepo.findByServerName('notion');
    expect(rowAfterClear?.version).toBe(2);

    // 迟到的旧续期请求仍按 version = 1 尝试写库, 应被拦截
    const staleUpdated = credentialsRepo.updateTokensIfVersionMatches({
      mcpServerName: 'notion',
      version: 1,
      accessToken: 'stale-token',
      refreshToken: 'stale-refresh',
      expiresAtMs: 9999,
      updatedAt: 2000,
    });

    expect(staleUpdated).toBe(false);

    // 数据库保持清除后的状态, Token 不被污染
    const current = credentialsRepo.findByServerName('notion');
    expect(current?.version).toBe(2);
    expect(current?.access_token).toBeNull();
    expect(current?.refresh_token).toBeNull();
  });

  it('清除授权时清空 Token 并自增版本号, 保留客户端注册信息', () => {
    credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-permanent',
      clientSecret: 'secret-permanent',
      accessToken: 'token-acc-1',
      refreshToken: 'refresh-acc-1',
      expiresAtMs: 3000,
      updatedAt: 1000,
    });

    const cleared = credentialsRepo.clearTokens('notion', 2000);
    expect(cleared).toBe(true);

    const row = credentialsRepo.findByServerName('notion');
    expect(row?.version).toBe(2);
    expect(row?.access_token).toBeNull();
    expect(row?.refresh_token).toBeNull();
    expect(row?.expires_at_ms).toBeNull();
    // 客户端登记依然保留, 下次重新登录免去动态注册
    expect(row?.client_id).toBe('client-permanent');
    expect(row?.client_secret).toBe('secret-permanent');
  });

  it('saveInitialOrClient 在 serverUrl 或 clientId 变更时清空旧 Token 与密钥, 未变更时保留', () => {
    credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      expiresAtMs: 3000,
      updatedAt: 1000,
    });

    // 同 serverUrl 与 clientId 下仅更新基本信息时, 保留已存 secret 与 Token
    credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-1',
      updatedAt: 1500,
    });

    const unchanged = credentialsRepo.findByServerName('notion');
    expect(unchanged?.client_secret).toBe('secret-1');
    expect(unchanged?.access_token).toBe('token-1');
    expect(unchanged?.refresh_token).toBe('refresh-1');
    expect(unchanged?.expires_at_ms).toBe(3000);

    // 变更 serverUrl 时清空旧 secret 与 Token, 且版本号自增
    credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.example.com/mcp',
      clientId: 'client-1',
      updatedAt: 2000,
    });

    const urlChanged = credentialsRepo.findByServerName('notion');
    expect(urlChanged?.server_url).toBe('https://mcp.example.com/mcp');
    expect(urlChanged?.client_id).toBe('client-1');
    expect(urlChanged?.client_secret).toBeNull();
    expect(urlChanged?.access_token).toBeNull();
    expect(urlChanged?.refresh_token).toBeNull();
    expect(urlChanged?.expires_at_ms).toBeNull();
    expect(urlChanged?.version).toBeGreaterThan(unchanged!.version);

    // 重新写入新客户端的密钥和 Token, 再变更 clientId 时同样清空
    credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.example.com/mcp',
      clientId: 'client-1',
      clientSecret: 'secret-new',
      accessToken: 'token-new',
      refreshToken: 'refresh-new',
      expiresAtMs: 5000,
      updatedAt: 2500,
    });

    credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.example.com/mcp',
      clientId: 'client-2',
      updatedAt: 3000,
    });

    const clientChanged = credentialsRepo.findByServerName('notion');
    expect(clientChanged?.client_id).toBe('client-2');
    expect(clientChanged?.client_secret).toBeNull();
    expect(clientChanged?.token_endpoint_auth_method).toBeNull();
    expect(clientChanged?.redirect_uris_json).toBeNull();
    expect(clientChanged?.client_secret_expires_at_ms).toBeNull();
    expect(clientChanged?.access_token).toBeNull();
    expect(clientChanged?.refresh_token).toBeNull();
    expect(clientChanged?.expires_at_ms).toBeNull();
  });

  it('保存并保留客户端认证方式, 回跳地址列表与密钥过期时间, clearTokens 后不丢失', () => {
    const saved = credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-meta-1',
      clientSecret: 'secret-meta-1',
      tokenEndpointAuthMethod: 'client_secret_post',
      redirectUrisJson: JSON.stringify(['http://127.0.0.1:50483/oauth/callback']),
      clientSecretExpiresAtMs: 1_900_000_000_000,
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      expiresAtMs: 3000,
      updatedAt: 1000,
    });

    expect(saved.token_endpoint_auth_method).toBe('client_secret_post');
    expect(saved.redirect_uris_json).toBe('["http://127.0.0.1:50483/oauth/callback"]');
    expect(saved.client_secret_expires_at_ms).toBe(1_900_000_000_000);

    credentialsRepo.clearTokens('notion', 2000);
    const afterClear = credentialsRepo.findByServerName('notion');
    expect(afterClear?.access_token).toBeNull();
    expect(afterClear?.token_endpoint_auth_method).toBe('client_secret_post');
    expect(afterClear?.redirect_uris_json).toBe('["http://127.0.0.1:50483/oauth/callback"]');
    expect(afterClear?.client_secret_expires_at_ms).toBe(1_900_000_000_000);

    // 更换新 client_id 重新注册时, 必须覆盖/清空旧客户端注册元数据
    credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-meta-2',
      updatedAt: 3000,
    });
    const replaced = credentialsRepo.findByServerName('notion');
    expect(replaced?.client_id).toBe('client-meta-2');
    expect(replaced?.token_endpoint_auth_method).toBeNull();
    expect(replaced?.redirect_uris_json).toBeNull();
    expect(replaced?.client_secret_expires_at_ms).toBeNull();
  });

  it('父级 mcp_servers 记录删除时级联删除对应的 OAuth 凭据', () => {
    credentialsRepo.saveInitialOrClient({
      mcpServerName: 'notion',
      serverUrl: 'https://mcp.notion.com/mcp',
      clientId: 'client-123',
      updatedAt: 1000,
    });

    expect(credentialsRepo.findByServerName('notion')).not.toBeNull();

    serversRepo.deleteById('srv-notion');
    expect(credentialsRepo.findByServerName('notion')).toBeNull();
  });
});
