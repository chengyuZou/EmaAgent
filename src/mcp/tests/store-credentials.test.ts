// 测试 McpServerStore 在写边界加密 env/headers、读边界 reveal 回明文 domain。
import { describe, expect, it } from 'vitest';
import { McpServerStore } from '../store.js';
import { createTestCredentialFacade } from './helpers/test-credential-facade.js';

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
  it('stdio env 值落库为信封,读取回明文', () => {
    const repo = memoryRepo();
    const store = new McpServerStore(repo as never, createTestCredentialFacade());

    store.register('github', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_secret', DEBUG: '1' },
    });

    const persisted = JSON.parse(repo.findByName('github')!.config_json as string);
    // 全部值都加密,不分类;明文绝不落库
    expect(persisted.env.GITHUB_TOKEN).toMatch(/^ema-credential:v1:/);
    expect(persisted.env.GITHUB_TOKEN).not.toContain('ghp_secret');
    expect(persisted.env.DEBUG).toMatch(/^ema-credential:v1:/);

    const record = store.findByName('github')!;
    expect(record.config).toMatchObject({
      type: 'stdio',
      env: { GITHUB_TOKEN: 'ghp_secret', DEBUG: '1' },
    });
  });

  it('http headers 值落库为信封,读取回明文', () => {
    const repo = memoryRepo();
    const store = new McpServerStore(repo as never, createTestCredentialFacade());

    store.register('remote', {
      type: 'http',
      url: 'https://mcp.example.com/x/mcp',
      headers: { Authorization: 'Bearer tok_123' },
    });

    const persisted = JSON.parse(repo.findByName('remote')!.config_json as string);
    expect(persisted.headers.Authorization).toMatch(/^ema-credential:v1:/);
    expect(persisted.headers.Authorization).not.toContain('tok_123');

    expect(store.findByName('remote')!.config).toMatchObject({
      type: 'http',
      headers: { Authorization: 'Bearer tok_123' },
    });
  });

  it('AAD 绑定记录 id:把信封换到另一条记录下拒绝解密', () => {
    const facade = createTestCredentialFacade();
    const envelope = facade.protect('server-a', 'secret');
    expect(facade.reveal('server-a', envelope)).toBe('secret');
    expect(() => facade.reveal('server-b', envelope)).toThrow();
  });

  it('更新同名 server 沿用既有 id,旧信封仍可 reveal', () => {
    const repo = memoryRepo();
    const store = new McpServerStore(repo as never, createTestCredentialFacade());

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
    const store = new McpServerStore(repo as never, createTestCredentialFacade());

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
