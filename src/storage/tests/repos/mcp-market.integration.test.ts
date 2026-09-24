import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, McpMarketEntriesRepo, McpServersRepo } from '../../index.js';

describe('MCP 持久化', () => {
  let database: Database;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
  });

  afterEach(() => database.close());

  it('保存固定市场来源与条目身份', () => {
    const repo = new McpServersRepo(database.sqlite);
    repo.insert({
      id: 'mcp-1',
      name: 'filesystem',
      install_source: 'official',
      market_entry_id: 'io.example/filesystem',
      config_json: JSON.stringify({ type: 'stdio', command: 'npx', args: ['-y', '@example/mcp'] }),
      tools_cache: null,
      enabled: 1,
      installed_at: 1,
    });
    expect(repo.findByName('filesystem')).toMatchObject({
      install_source: 'official',
      market_entry_id: 'io.example/filesystem',
    });
  });

  it('Server 列表投影只读取设置并计算缓存工具数量', () => {
    const repo = new McpServersRepo(database.sqlite);
    repo.insert({
      id: 'mcp-summary',
      name: 'summary-only',
      install_source: 'manual',
      market_entry_id: null,
      config_json: JSON.stringify({ type: 'http', url: 'https://example.com/mcp' }),
      tools_cache: JSON.stringify([
        { serverToolName: 'one', inputSchema: { type: 'object' } },
        { serverToolName: 'two', inputSchema: { type: 'object' } },
      ]),
      enabled: 1,
      installed_at: 2,
    });

    const settings = repo.listSettings();
    expect(settings).toEqual([{
      name: 'summary-only',
      install_source: 'manual',
      market_entry_id: null,
      config_json: JSON.stringify({ type: 'http', url: 'https://example.com/mcp' }),
      enabled: 1,
      cached_tool_count: 2,
    }]);
    expect(settings[0]).not.toHaveProperty('tools_cache');
  });

  it('刷新时整批替换 Official Registry 缓存', () => {
    const repo = new McpMarketEntriesRepo(database.sqlite);
    repo.replaceSource('official', [{
      source: 'official',
      external_id: 'a', name: 'A', description: '',
      repository_url: null, detail_url: 'https://example.com/a',
    }]);
    repo.replaceSource('official', []);
    expect(repo.fetchState('official')).toEqual({ source: 'official', next_cursor: null });
    expect(repo.listPage('official', '', 0, 40)).toEqual({ rows: [], total: 0 });
  });

  it('逐页追加市场缓存并保存下一页 cursor', () => {
    const repo = new McpMarketEntriesRepo(database.sqlite);
    repo.appendPage('official', [{
      source: 'official', external_id: 'a', name: 'A', description: '',
      repository_url: null, detail_url: 'https://example.com/a',
    }], 'page-2');
    repo.appendPage('official', [{
      source: 'official', external_id: 'b', name: 'B', description: '',
      repository_url: null, detail_url: 'https://example.com/b',
    }], null);

    expect(repo.fetchState('official')).toEqual({ source: 'official', next_cursor: null });
    expect(repo.listPage('official', '', 0, 40).total).toBe(2);
  });

  it('按名称和说明搜索并分页', () => {
    const repo = new McpMarketEntriesRepo(database.sqlite);
    repo.replaceSource('official', [
      { source: 'official', external_id: 'b', name: 'Beta', description: 'database', repository_url: null, detail_url: 'https://example.com/b' },
      { source: 'official', external_id: 'a', name: 'Alpha', description: 'filesystem', repository_url: null, detail_url: 'https://example.com/a' },
      { source: 'official', external_id: 'c', name: 'Gamma', description: 'filesystem tools', repository_url: null, detail_url: 'https://example.com/c' },
    ]);

    expect(repo.listPage('official', 'file', 0, 1)).toEqual({
      rows: [{ source: 'official', external_id: 'a', name: 'Alpha', description: 'filesystem', repository_url: null, detail_url: 'https://example.com/a' }],
      total: 2,
    });
  });
});
