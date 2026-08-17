// 测试 McpServerStore 对 env/headers 的明文持久化与读取(V1 不做凭据加密)。
import { describe, expect, it } from 'vitest';
import { McpServerStore } from '../store.js';

function memoryRepo() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    findByName: (name: string) => [...rows.values()].find((r) => r.name === name) ?? null,
    insert: (row: Record<string, unknown>) => { rows.set(row.id as string, row); },
    update: (id: string, patch: Record<string, unknown>) => {
      const row = rows.get(id);
      if (!row) return;
      for (const [key, value] of Object.entries(patch)) {
        // repo.update 的 camelCase patch 键 ↔ snake_case 列
        const col = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        row[col] = value;
      }
    },
    deleteById: (id: string) => { rows.delete(id); },
    listAll: () => [...rows.values()],
    listEnabled: () => [...rows.values()].filter((r) => r.enabled === 1),
  };
}

describe('McpServerStore 凭据边界', () => {
  it('stdio env 值明文落库,读取回原值', () => {
    const repo = memoryRepo();
    const store = new McpServerStore(repo as never);

    store.register('github', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_secret', DEBUG: '1' },
    });

    const persisted = JSON.parse(repo.findByName('github')!.config_json as string);
    // V1 明文直存,不加密
    expect(persisted.env.GITHUB_TOKEN).toBe('ghp_secret');
    expect(persisted.env.DEBUG).toBe('1');

    const record = store.findByName('github')!;
    expect(record.config).toMatchObject({
      type: 'stdio',
      env: { GITHUB_TOKEN: 'ghp_secret', DEBUG: '1' },
    });
  });

  it('http headers 值明文落库,读取回原值', () => {
    const repo = memoryRepo();
    const store = new McpServerStore(repo as never);

    store.register('remote', {
      type: 'http',
      url: 'https://mcp.example.com/x/mcp',
      headers: { Authorization: 'Bearer tok_123' },
    });

    const persisted = JSON.parse(repo.findByName('remote')!.config_json as string);
    expect(persisted.headers.Authorization).toBe('Bearer tok_123');

    expect(store.findByName('remote')!.config).toMatchObject({
      type: 'http',
      headers: { Authorization: 'Bearer tok_123' },
    });
  });

  it('更新同名 server 沿用既有 id,配置覆盖', () => {
    const repo = memoryRepo();
    const store = new McpServerStore(repo as never);

    store.register('s', { type: 'http', url: 'https://a.example/mcp', headers: { 'X-Key': 'one' } });
    store.register('s', { type: 'http', url: 'https://b.example/mcp', headers: { 'X-Key': 'two' } });

    expect(store.listAll()).toHaveLength(1);
    expect(store.findByName('s')!.config).toMatchObject({
      url: 'https://b.example/mcp',
      headers: { 'X-Key': 'two' },
    });
  });

  it('registry provenance 三列往返;损坏 provenance 降级 manual', () => {
    const repo = memoryRepo();
    const store = new McpServerStore(repo as never);

    store.register('marked', { type: 'http', url: 'https://a.example/mcp' }, undefined, {
      sourceKind: 'registry',
      registrySourceId: 'official',
      registryEntryId: 'io.example/x',
      registryVersion: '1.0.0',
    });
    expect(store.findByName('marked')!.provenance).toEqual({
      sourceKind: 'registry',
      registrySourceId: 'official',
      registryEntryId: 'io.example/x',
      registryVersion: '1.0.0',
    });

    // 三列缺一视为损坏,降级 manual
    const row = repo.findByName('marked')!;
    row.registry_version = null;
    expect(store.findByName('marked')!.provenance).toEqual({ sourceKind: 'manual' });
  });
});
