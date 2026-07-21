// 这里测试 MCP 市场包只生成精确版本启动参数，并拒绝伪造或缺失锁定信息。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import { McpServerStore } from '../store.js';

const mocks = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock('@ema-agent/marketplace', async (importOriginal) => {
  const original = await importOriginal<typeof import('@ema-agent/marketplace')>();
  return { ...original, fetchJson: mocks.fetchJson };
});

import { list as listJsonIndex } from '../market/handlers/json-index.js';
import { list as listRegistry } from '../market/handlers/mcp-registry.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MCP 市场版本锁定', () => {
  it('官方 npm 和 PyPI package 使用各自 package version 生成精确参数', async () => {
    mocks.fetchJson.mockResolvedValue({
      servers: [
        {
          server: {
            name: 'npm-server',
            version: '9.9.9',
            packages: [
              {
                registryType: 'oci',
                identifier: 'registry.example.com/mcp-server',
                version: '1.2.3',
              },
              {
                registryType: 'npm',
                identifier: '@example/mcp-server',
                version: '1.2.3',
              },
            ],
          },
        },
        {
          server: {
            name: 'pypi-server',
            packages: [{
              registry_type: 'pypi',
              identifier: 'example-mcp',
              version: '2.0.0rc1',
            }],
          },
        },
      ],
      metadata: {},
    });

    const result = await listRegistry(source('mcp-registry'));

    expect(result).toEqual([
      expect.objectContaining({
        name: 'npm-server',
        command: 'npx',
        args: ['-y', '@example/mcp-server@1.2.3'],
        packageVersion: '1.2.3',
        installable: true,
      }),
      expect.objectContaining({
        name: 'pypi-server',
        command: 'uvx',
        args: ['example-mcp==2.0.0rc1'],
        packageVersion: '2.0.0rc1',
        installable: true,
      }),
    ]);
  });

  it('官方 package 缺少精确版本时保留展示但禁止安装', async () => {
    mocks.fetchJson.mockResolvedValue({
      servers: [{
        server: {
          name: 'floating-server',
          packages: [{ registryType: 'npm', identifier: 'floating-mcp' }],
        },
      }],
      metadata: {},
    });

    await expect(listRegistry(source('mcp-registry'))).resolves.toEqual([
      expect.objectContaining({
        name: 'floating-server',
        transport: 'stdio',
        installable: false,
        unavailableReason: expect.stringContaining('精确版本'),
      }),
    ]);
  });

  it('JSON 市场的 npx 配置必须提供独立包字段，且启动参数由后端重建', async () => {
    mocks.fetchJson.mockResolvedValue({
      entries: [
        {
          name: 'floating',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'floating-mcp'],
        },
        {
          name: 'locked',
          transport: 'stdio',
          command: 'npx',
          args: ['malicious-ignored-arg'],
          packageRegistry: 'npm',
          packageName: 'locked-mcp',
          packageVersion: '3.1.4',
        },
      ],
    });

    const result = await listJsonIndex(source('json-index'));

    expect(result[0]).toMatchObject({ installable: false });
    expect(result[1]).toMatchObject({
      installable: true,
      command: 'npx',
      args: ['-y', 'locked-mcp@3.1.4'],
    });
  });

  it('Store 拒绝与 provenance 不一致的市场启动参数', () => {
    const repo = { findByName: vi.fn(() => null), insert: vi.fn() };
    const store = new McpServerStore(repo as never);

    expect(() => store.register(
      'tampered',
      { type: 'stdio', command: 'npx', args: ['-y', 'other@latest'] },
      undefined,
      {
        sourceKind: 'market',
        marketSourceId: 'official',
        marketSourceType: 'mcp-registry',
        packageRegistry: 'npm',
        packageName: 'safe-mcp',
        packageVersion: '1.0.0',
      },
    )).toThrow(/does not match/i);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it.each(['latest', '1.2.x'])(
    'Store 不把浮动版本 %s 当作精确版本锁定',
    (packageVersion) => {
      const repo = { findByName: vi.fn(() => null), insert: vi.fn() };
      const store = new McpServerStore(repo as never);

      expect(() => store.register(
        'floating',
        { type: 'stdio', command: 'npx', args: ['-y', `unsafe-mcp@${packageVersion}`] },
        undefined,
        {
          sourceKind: 'market',
          marketSourceId: 'official',
          marketSourceType: 'mcp-registry',
          packageRegistry: 'npm',
          packageName: 'unsafe-mcp',
          packageVersion,
        },
      )).toThrow(/exact version/i);
      expect(repo.insert).not.toHaveBeenCalled();
    },
  );
});

function source(type: string): MarketSourceRecord {
  return {
    id: `source-${type}`,
    kind: 'mcp',
    type,
    label: type,
    config: type === 'json-index'
      ? JSON.stringify({ indexUrl: 'https://example.com/index.json' })
      : JSON.stringify({ baseUrl: 'https://example.com/registry' }),
    enabled: true,
    builtin: false,
    sortOrder: 0,
    createdAt: 1,
  };
}
