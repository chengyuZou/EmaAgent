// 测试 Registry 源的 cursor 客户端、条目解析与安装管线。
import { describe, expect, it, vi } from 'vitest';
import { fetchRegistryEntries } from '../registrySources/registryClient.js';
import { resolveRegistryEntry } from '../registrySources/entryResolver.js';
import { installRegistryEntry } from '../registrySources/install.js';
import type { RawRegistryServer } from '../registrySources/types.js';
import type { McpRegistrySource } from '../registrySources/types.js';
import { McpServerStore } from '../store.js';
import { createTestCredentialFacade } from './helpers/test-credential-facade.js';

function page(servers: unknown[], nextCursor?: string) {
  return {
    servers: servers.map((server) => ({ server, _meta: {} })),
    metadata: nextCursor ? { nextCursor } : {},
  };
}

const REMOTE_ENTRY = {
  name: 'ac.inference.sh/mcp',
  title: 'inference.sh',
  description: 'Run 150+ AI apps',
  version: '1.0.1',
  remotes: [{ type: 'streamable-http', url: 'https://api.inference.sh/mcp' }],
};

describe('fetchRegistryEntries', () => {
  it('按 cursor 翻页、带 version=latest、包裹形态解包', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (!url.includes('cursor=')) return page([REMOTE_ENTRY], 'ac.inference.sh/mcp:1.0.1');
      return page([{ ...REMOTE_ENTRY, version: '1.0.1' }]);
    });

    const result = await fetchRegistryEntries('https://registry.example/v0/servers', { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('version=latest');
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('cursor=ac.inference.sh');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ name: 'ac.inference.sh/mcp', version: '1.0.1' });
    expect(result.skipped).toBe(0);
  });

  it('Schema 不符的条目跳过并计数,不拖垮整页', async () => {
    const fetcher = vi.fn(async () => page([
      REMOTE_ENTRY,
      { broken: true },
      42,
    ]));
    const result = await fetchRegistryEntries('https://registry.example/v0/servers', { fetcher });
    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });
});

describe('resolveRegistryEntry', () => {
  const resolve = (raw: unknown) =>
    resolveRegistryEntry(raw as RawRegistryServer);

  it('streamable-http remote 直连', () => {
    const entry = resolve(REMOTE_ENTRY);
    expect(entry).toMatchObject({
      installable: true,
      spec: { transport: 'http', url: 'https://api.inference.sh/mcp' },
    });
  });

  it('同时提供 sse 与 streamable-http 时选后者;仅 sse 判不可安装', () => {
    const dual = resolve({
      name: 'dual', version: '1.0.0',
      remotes: [
        { type: 'sse', url: 'https://x.example/sse' },
        { type: 'streamable-http', url: 'https://x.example/mcp' },
      ],
    });
    expect(dual.spec).toMatchObject({ transport: 'http', url: 'https://x.example/mcp' });

    const sseOnly = resolve({
      name: 'legacy', version: '1.0.0',
      remotes: [{ type: 'sse', url: 'https://x.example/sse' }],
    });
    expect(sseOnly.installable).toBe(false);
    expect(sseOnly.unavailableReason).toContain('SSE');
  });

  it('npm 包精确版本锁定为 npx stdio 启动', () => {
    const entry = resolve({
      name: 'io.example/filesystem', version: '1.2.3',
      packages: [{
        registryType: 'npm',
        identifier: '@example/mcp-filesystem',
        version: '1.2.3',
      }],
    });
    expect(entry).toMatchObject({
      installable: true,
      spec: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/mcp-filesystem@1.2.3'],
      },
    });
  });

  it('浮动版本(1.x)拒绝安装', () => {
    const entry = resolve({
      name: 'io.example/floating', version: '1.0.0',
      packages: [{ registryType: 'npm', identifier: '@example/x', version: '1.x' }],
    });
    expect(entry.installable).toBe(false);
    expect(entry.unavailableReason).toContain('精确版本');
  });

  it('pypi 包 + 字面量参数映射 + 必填 env 冒到 requiredInputs', () => {
    const entry = resolve({
      name: 'io.example/fetch', version: '2.0.0',
      packages: [{
        registry_type: 'pypi',
        identifier: 'mcp-server-fetch',
        version: '2.0.0',
        package_arguments: [
          { type: 'named', name: '--timeout', value: '30' },
          { type: 'positional', value: '--verbose' },
        ],
        environment_variables: [
          { name: 'API_KEY', is_required: true, is_secret: true, description: '服务密钥' },
          { name: 'REGION', default: 'us-east-1' },
        ],
      }],
    });
    expect(entry.installable).toBe(true);
    expect(entry.spec).toMatchObject({
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch==2.0.0', '--timeout=30', '--verbose'],
      env: { REGION: 'us-east-1' },
    });
    expect(entry.requiredInputs).toEqual([
      { key: 'API_KEY', target: 'env', isSecret: true, description: '服务密钥' },
    ]);
  });

  it('模板参数({placeholder})的条目不可安装', () => {
    const entry = resolve({
      name: 'io.example/templated', version: '1.0.0',
      packages: [{
        registryType: 'npm',
        identifier: '@example/t',
        version: '1.0.0',
        package_arguments: [{ type: 'positional', value: '{workspace}' }],
      }],
    });
    expect(entry.installable).toBe(false);
  });
});

describe('installRegistryEntry', () => {
  const source: McpRegistrySource = {
    id: 'official-mcp-registry',
    label: 'MCP 官方 Registry',
    registryUrl: 'https://registry.modelcontextprotocol.io/v0/servers',
    enabled: true,
    builtin: true,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  function memoryStore() {
    const rows = new Map<string, Record<string, unknown>>();
    const repo = {
      findByName: (name: string) => [...rows.values()].find((r) => r.name === name) ?? null,
      insert: (row: Record<string, unknown>) => { rows.set(row.id as string, row); },
      update: vi.fn(),
      deleteById: (id: string) => { rows.delete(id); },
      listAll: () => [...rows.values()],
      listEnabled: () => [...rows.values()].filter((r) => r.enabled === 1),
    };
    return {
      rows,
      store: new McpServerStore(repo as never, createTestCredentialFacade()),
    };
  }

  it('remote 条目落成 http 配置并写 registry 溯源', () => {
    const { rows, store } = memoryStore();
    const entry = resolveRegistryEntry(REMOTE_ENTRY as RawRegistryServer);

    const id = installRegistryEntry({ store, source, entry });

    const row = [...rows.values()][0]!;
    expect(row.id).toBe(id);
    expect(row.name).toBe('inference.sh');
    expect(row.install_source).toBe('registry');
    expect(row.registry_entry_id).toBe('ac.inference.sh/mcp');
    expect(row.registry_version).toBe('1.0.1');
    expect(JSON.parse(row.config_json as string)).toEqual({
      type: 'http',
      url: 'https://api.inference.sh/mcp',
    });
  });

  it('必填输入缺失时拒绝安装;提供后合并进 env 并加密落库', () => {
    const { rows, store } = memoryStore();
    const entry = resolveRegistryEntry({
      name: 'io.example/fetch', version: '2.0.0',
      packages: [{
        registryType: 'pypi',
        identifier: 'mcp-server-fetch',
        version: '2.0.0',
        environment_variables: [{ name: 'API_KEY', is_required: true }],
      }],
    } as RawRegistryServer);

    expect(() => installRegistryEntry({ store, source, entry })).toThrow(/API_KEY/);

    installRegistryEntry({ store, source, entry, inputs: { API_KEY: 'sk-live' } });
    const persisted = JSON.parse([...rows.values()][0]!.config_json as string);
    expect(persisted.env.API_KEY).toMatch(/^ema-credential:v1:/);
    expect(persisted.env.API_KEY).not.toContain('sk-live');
  });
});
