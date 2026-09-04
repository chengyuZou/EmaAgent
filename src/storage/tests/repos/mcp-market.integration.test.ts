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

  it('刷新时整批替换 Official Registry 缓存', () => {
    const repo = new McpMarketEntriesRepo(database.sqlite);
    repo.replaceSource('official', [{
      source: 'official',
      external_id: 'a', name: 'A', description: '',
      repository_url: null, detail_url: 'https://example.com/a',
    }]);
    repo.replaceSource('official', []);
    expect(repo.hasEntries('official')).toBe(false);
    expect(repo.listPage('official', '', 0, 40)).toEqual({ rows: [], total: 0 });
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
