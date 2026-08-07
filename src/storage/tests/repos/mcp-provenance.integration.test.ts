// 这里测试 MCP 安装溯源(registry 源/条目/锁定版本)使用独立数据库列完整往返。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, McpServersRepo, McpRegistrySourcesRepo } from '../../index.js';

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

  it('registry 源、条目与锁定版本完整往返', () => {
    repo.insert({
      id: 'mcp-1',
      name: 'filesystem',
      source_url: 'https://github.com/example/filesystem',
      install_source: 'registry',
      registry_source_id: 'official-mcp',
      registry_entry_id: 'io.github.example/filesystem',
      registry_version: '1.2.3',
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
      install_source: 'registry',
      registry_source_id: 'official-mcp',
      registry_entry_id: 'io.github.example/filesystem',
      registry_version: '1.2.3',
    });
  });

  it('手动覆盖配置时可以明确清除旧 registry provenance', () => {
    repo.insert({
      id: 'mcp-2',
      name: 'custom',
      source_url: null,
      install_source: 'registry',
      registry_source_id: 'source',
      registry_entry_id: 'io.github.example/custom-mcp',
      registry_version: '2.0.0',
      config_json: '{}',
      tools_cache: null,
      cached_at: 0,
      enabled: 1,
      installed_at: 1,
    });

    repo.update('mcp-2', {
      installSource: 'manual',
      registrySourceId: null,
      registryEntryId: null,
      registryVersion: null,
    });

    expect(repo.findByName('custom')).toMatchObject({
      install_source: 'manual',
      registry_source_id: null,
      registry_entry_id: null,
      registry_version: null,
    });
  });
});

describe('MCP registry sources 仓储', () => {
  let database: Database;
  let repo: McpRegistrySourcesRepo;

  beforeEach(() => {
    database = new Database({ memory: true, kind: 'profile' });
    database.migrate();
    repo = new McpRegistrySourcesRepo(database.sqlite);
  });

  afterEach(() => {
    database.close();
  });

  it('插入/启用过滤/更新/删除按预期工作,builtin 不可删', () => {
    repo.insert({
      id: 'official',
      label: 'MCP 官方 Registry',
      registry_url: 'https://registry.modelcontextprotocol.io/v0/servers',
      builtin: 1,
      sort_order: 0,
      created_at: 1,
      updated_at: 1,
    });
    repo.insert({
      id: 'mirror',
      label: '私有镜像',
      registry_url: 'https://mirror.example.com/v0/servers',
      builtin: 0,
      sort_order: 1,
      enabled: 0,
      created_at: 2,
      updated_at: 2,
    });

    expect(repo.listAll().map((r) => r.id)).toEqual(['official', 'mirror']);
    expect(repo.listEnabled().map((r) => r.id)).toEqual(['official']);

    repo.update('mirror', { enabled: 1, label: '公司镜像', updated_at: 3 });
    expect(repo.findById('mirror')).toMatchObject({ enabled: 1, label: '公司镜像' });

    expect(repo.deleteById('official')).toBe(false);  // builtin 保护
    expect(repo.deleteById('mirror')).toBe(true);
    expect(repo.listAll().map((r) => r.id)).toEqual(['official']);
  });
});
