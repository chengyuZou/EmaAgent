// 这里测试 MCP 安装来源和锁定包版本使用独立数据库列完整往返。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, McpServersRepo } from '../../src/index.js';

describe('MCP 安装 provenance 仓储', () => {
  let database: Database;
  let repo: McpServersRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    repo = new McpServersRepo(database.sqlite);
  });

  afterEach(() => {
    database.close();
  });

  it('市场来源、包 registry、名称和精确版本完整往返', () => {
    repo.insert({
      id: 'mcp-1',
      name: 'filesystem',
      source_url: 'https://github.com/example/filesystem',
      install_source: 'market',
      market_source_id: 'official-mcp',
      market_source_type: 'mcp-registry',
      package_registry: 'npm',
      package_name: '@example/mcp-filesystem',
      package_version: '1.2.3',
      package_integrity: null,
      config_json: JSON.stringify({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@example/mcp-filesystem@1.2.3'],
      }),
      tools_cache: null,
      cached_at: 0,
      enabled: 1,
      installed_at: 1,
    });

    expect(repo.findByName('filesystem')).toMatchObject({
      install_source: 'market',
      market_source_id: 'official-mcp',
      package_registry: 'npm',
      package_name: '@example/mcp-filesystem',
      package_version: '1.2.3',
    });
  });

  it('手动覆盖配置时可以明确清除旧市场 provenance', () => {
    repo.insert({
      id: 'mcp-2',
      name: 'custom',
      source_url: null,
      install_source: 'market',
      market_source_id: 'source',
      market_source_type: 'mcp-registry',
      package_registry: 'pypi',
      package_name: 'custom-mcp',
      package_version: '2.0.0',
      package_integrity: null,
      config_json: '{}',
      tools_cache: null,
      cached_at: 0,
      enabled: 1,
      installed_at: 1,
    });

    repo.update('mcp-2', {
      installSource: 'manual',
      marketSourceId: null,
      marketSourceType: null,
      packageRegistry: null,
      packageName: null,
      packageVersion: null,
      packageIntegrity: null,
    });

    expect(repo.findByName('custom')).toMatchObject({
      install_source: 'manual',
      market_source_id: null,
      package_registry: null,
      package_name: null,
      package_version: null,
    });
  });
});
