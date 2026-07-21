// 这里测试旧 SSE transport 被明确拒绝，市场只保留 stdio 和 Streamable HTTP。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketSourceRecord } from '@ema-agent/marketplace';
import { McpUnsupportedTransportError } from '../errors.js';
import { parseImportedMcpServers } from '../config-import.js';
import { McpServerStore } from '../store.js';
import { McpServerConfigSchema } from '../types.js';

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

describe('MCP transport 版本边界', () => {
  it('公共配置 Schema 不再接受 sse', () => {
    expect(McpServerConfigSchema.safeParse({
      type: 'sse',
      url: 'https://legacy.example/sse',
    }).success).toBe(false);
  });

  it('导入显式或可识别的旧 SSE 配置时给出迁移错误', () => {
    expect(() => parseImportedMcpServers({
      mcpServers: {
        legacy: { type: 'sse', url: 'https://legacy.example/events' },
      },
    })).toThrow(McpUnsupportedTransportError);

    expect(() => parseImportedMcpServers({
      mcpServers: {
        legacy: { url: 'https://legacy.example/sse/' },
      },
    })).toThrow('configure a Streamable HTTP endpoint or stdio');
  });

  it('显式 http 配置不根据 URL 名字猜协议', () => {
    expect(parseImportedMcpServers({
      mcpServers: {
        current: { type: 'http', url: 'https://example.com/custom/sse' },
      },
    })).toEqual([{
      name: 'current',
      config: { type: 'http', url: 'https://example.com/custom/sse' },
    }]);
  });

  it('旧数据库记录不会在读取时被偷偷转换成 HTTP', () => {
    const repo = {
      findByName: () => ({
        id: 'legacy-id',
        name: 'legacy',
        source_url: null,
        config_json: JSON.stringify({ type: 'sse', url: 'https://legacy.example/sse' }),
        tools_cache: null,
        cached_at: 0,
        enabled: 1,
        installed_at: 1,
      }),
    };
    const store = new McpServerStore(repo as never);

    expect(() => store.findByName('legacy')).toThrow(McpUnsupportedTransportError);
  });

  it('JSON 市场过滤 SSE 条目并保留 HTTP 与 stdio', async () => {
    mocks.fetchJson.mockResolvedValue({
      entries: [
        { name: 'legacy-explicit', transport: 'sse', url: 'https://example.com/events' },
        { name: 'legacy-inferred', url: 'https://example.com/sse' },
        { name: 'remote', transport: 'http', url: 'https://example.com/mcp' },
        { name: 'local', transport: 'stdio', command: 'node', args: ['server.js'] },
      ],
    });

    const result = await listJsonIndex(source('json-index'));

    expect(result.map(entry => entry.name)).toEqual(['remote', 'local']);
  });

  it('官方 Registry 同时提供 SSE 和 HTTP 时选择 HTTP，仅 SSE 时跳过', async () => {
    mocks.fetchJson.mockResolvedValue({
      servers: [
        {
          server: {
            name: 'dual',
            remotes: [
              { type: 'sse', url: 'https://example.com/sse' },
              { type: 'streamable-http', url: 'https://example.com/mcp' },
            ],
          },
        },
        {
          server: {
            name: 'legacy-only',
            remotes: [{ type: 'sse', url: 'https://legacy.example/sse' }],
          },
        },
      ],
      metadata: {},
    });

    await expect(listRegistry(source('mcp-registry'))).resolves.toEqual([
      expect.objectContaining({
        name: 'dual',
        transport: 'http',
        url: 'https://example.com/mcp',
      }),
    ]);
  });
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
