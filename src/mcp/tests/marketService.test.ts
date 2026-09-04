// 测试 Official MCP Registry 缓存读取, 刷新失败保留旧值和安装配置生成.

import { describe, expect, it, vi } from 'vitest';
import { McpMarketService } from '../market/marketService.js';
import type { McpMarketCatalog, McpMarketEntry } from '../market/types.js';
import type { McpMarketStore } from '../market/marketStore.js';
import type { McpRegistry } from '../registry.js';

const cached: McpMarketEntry = {
  source: 'official',
  externalId: 'io.example/cached',
  name: 'Cached',
  description: 'old',
  detailUrl: 'https://example.com/cached',
};

function setup(entries: McpMarketEntry[] = [cached], nextCursor: string | null = null) {
  let rows = entries;
  let fetchState: { nextCursor: string | null } | null = entries.length ? { nextCursor } : null;
  const store = {
    fetchState: vi.fn(() => fetchState),
    listPage: vi.fn((_source: 'official', query: string, page: number, pageSize: number) => {
      const matched = query
        ? rows.filter(row => `${row.name} ${row.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        : rows;
      return { items: matched, total: matched.length, page, pageSize };
    }),
    appendPage: vi.fn((_source: 'official', next: McpMarketEntry[], cursor: string | null) => {
      const byId = new Map(rows.map(row => [row.externalId, row]));
      for (const row of next) byId.set(row.externalId, row);
      rows = [...byId.values()];
      fetchState = { nextCursor: cursor };
    }),
    replace: vi.fn((_source: 'official', next: McpMarketEntry[]) => {
      rows = next;
      fetchState = { nextCursor: null };
    }),
  } as unknown as McpMarketStore;
  const catalog = {
    source: 'official' as const,
    page: vi.fn(),
    detail: vi.fn(),
  } satisfies McpMarketCatalog;
  const save = vi.fn(async () => 'mcp-installed');
  const changed = vi.fn();
  const service = new McpMarketService(
    store,
    [catalog],
    { save } as unknown as Pick<McpRegistry, 'save'>,
    changed,
  );
  return { service, catalog, store, save, changed };
}

describe('McpMarketService', () => {
  it('有完整 SQL 缓存时立即返回当前页并在后台刷新', async () => {
    const { service, catalog, store, changed } = setup();
    let finishRefresh!: (value: { items: McpMarketEntry[]; nextCursor: null }) => void;
    catalog.page.mockImplementation(() => new Promise(resolve => { finishRefresh = resolve; }));

    await expect(service.load('official', '', 1)).resolves.toEqual({
      items: [cached], total: 1, page: 1, pageSize: 40,
      complete: true,
      syncing: true,
    });

    expect(store.listPage).toHaveBeenCalledWith('official', '', 1, 40);
    expect(catalog.page).toHaveBeenCalledWith(undefined, undefined);
    expect(changed).not.toHaveBeenCalled();
    finishRefresh({ items: [cached], nextCursor: null });
    await vi.waitFor(() => expect(store.replace).toHaveBeenCalled());
  });

  it('刷新失败时保留 SQL 缓存并向下一次读取返回错误', async () => {
    const { service, catalog, store } = setup();
    catalog.page.mockRejectedValue(new Error('registry offline'));

    await expect(service.refresh('official')).rejects.toThrow('registry offline');
    expect(store.replace).not.toHaveBeenCalled();
  });

  it('无缓存时只等待第一页,写入后返回并在后台继续 cursor', async () => {
    const fresh = { ...cached, description: 'new' };
    const second = { ...cached, externalId: 'io.example/second', name: 'Second' };
    const { service, catalog, store, changed } = setup([]);
    let finishSecond!: (value: { items: McpMarketEntry[]; nextCursor: null }) => void;
    catalog.page
      .mockResolvedValueOnce({ items: [fresh], nextCursor: 'second-page' })
      .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));

    await expect(service.load('official', 'new', 1)).resolves.toEqual({
      items: [fresh], total: 1, page: 1, pageSize: 40,
      complete: false,
      syncing: true,
    });
    expect(store.appendPage).toHaveBeenCalledWith('official', [fresh], 'second-page');
    expect(changed).toHaveBeenCalledTimes(1);
    finishSecond({ items: [second], nextCursor: null });
    await vi.waitFor(() => expect(store.appendPage).toHaveBeenLastCalledWith('official', [second], null));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('安装时把必填 Header 写入配置并保存 Official 来源', async () => {
    const { service, catalog, save } = setup([]);
    catalog.detail.mockResolvedValue({
      ...cached,
      config: { type: 'http', url: 'https://example.com/mcp' },
      requiredInputs: [{ key: 'Authorization', target: 'header', secret: true }],
    });

    await expect(service.install({
      source: 'official',
      externalId: cached.externalId,
      name: 'example',
      inputs: { Authorization: 'Bearer token' },
    })).resolves.toEqual({ id: 'mcp-installed', name: 'example' });

    expect(save).toHaveBeenCalledWith(
      'example',
      {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      },
      { sourceKind: 'official', marketEntryId: cached.externalId },
    );
  });
});
