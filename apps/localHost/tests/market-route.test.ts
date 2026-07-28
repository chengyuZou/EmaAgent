// 测试市场源管理路由的配置校验、内置源保护和免落库连通性测试。

import { describe, expect, it, vi } from 'vitest';
import type {
  MarketSourceAdapter,
  MarketSourceRecord,
} from '@ema-agent/marketplace';
import { createMarketRouter } from '../src/routes/market.js';

type SourcesArg = Parameters<typeof createMarketRouter>[0];
type RegistryArg = Parameters<typeof createMarketRouter>[1];

function source(id: string, builtin = false): MarketSourceRecord {
  return {
    id,
    kind: 'mcp',
    type: 'json-index',
    label: '测试源',
    config: '{}',
    enabled: true,
    builtin,
    sortOrder: 100,
    createdAt: 1,
  };
}

function adapter(overrides: Partial<MarketSourceAdapter<unknown>> = {}) {
  const base: MarketSourceAdapter<unknown> = {
    kind: 'mcp',
    types: ['json-index'],
    list: vi.fn(async () => [{ name: 'entry-1' }]),
    validateConfig: vi.fn(() => ({ ok: true as const, config: '{"url":"https://x"}' })),
    describeTypes: vi.fn(() => []),
  };
  return { ...base, ...overrides };
}

function createApp(options: {
  records?: MarketSourceRecord[];
  adapter?: MarketSourceAdapter<unknown>;
} = {}) {
  const records = new Map((options.records ?? []).map((r) => [r.id, r]));
  const sources: SourcesArg = {
    list: vi.fn(() => [...records.values()]),
    get: vi.fn((id: string) => records.get(id)),
    create: vi.fn((input: Omit<MarketSourceRecord, 'createdAt'>) => ({
      ...input,
      createdAt: 1,
    })),
    update: vi.fn(),
    remove: vi.fn(),
  };
  const registry: RegistryArg = {
    getAdapter: vi.fn(() => options.adapter),
  };
  const app = createMarketRouter(sources, registry);
  return { app, sources, registry };
}

describe('市场源管理路由', () => {
  it('POST /sources 经 Adapter 校验后落库并返回 201', async () => {
    const validAdapter = adapter();
    const { app, sources } = createApp({ adapter: validAdapter });

    const response = await app.request('/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'mcp',
        type: 'json-index',
        label: '新源',
        config: { url: 'https://x' },
      }),
    });

    expect(response.status).toBe(201);
    expect(validAdapter.validateConfig).toHaveBeenCalledWith('json-index', { url: 'https://x' });
    expect(sources.create).toHaveBeenCalledWith(
      expect.objectContaining({ config: '{"url":"https://x"}', builtin: false }),
    );
  });

  it('POST /sources 配置未通过 Adapter 校验时返回 400 且不落库', async () => {
    const rejecting = adapter({
      validateConfig: vi.fn(() => ({ ok: false as const, error: 'url 必填' })),
    });
    const { app, sources } = createApp({ adapter: rejecting });

    const response = await app.request('/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'mcp',
        type: 'json-index',
        label: '新源',
        config: {},
      }),
    });

    expect(response.status).toBe(400);
    expect(sources.create).not.toHaveBeenCalled();
  });

  it('DELETE /sources/:id 内置源拒绝删除', async () => {
    const { app, sources } = createApp({ records: [source('builtin-1', true)] });

    const response = await app.request('/sources/builtin-1', { method: 'DELETE' });

    expect(response.status).toBe(400);
    expect(sources.remove).not.toHaveBeenCalled();
  });

  it('POST /sources/test 只试拉不落库', async () => {
    const validAdapter = adapter();
    const { app, sources } = createApp({ adapter: validAdapter });

    const response = await app.request('/sources/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'mcp',
        type: 'json-index',
        label: '临时',
        config: { url: 'https://x' },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, count: 1 });
    expect(validAdapter.list).toHaveBeenCalledOnce();
    expect(sources.create).not.toHaveBeenCalled();
  });
});
