// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@ema-agent/ui';
import { McpMarketPage } from '../src/settings/mcp/McpMarketPage.js';
import { useMcpStore } from '../src/stores/mcp.js';
import type { mcpApi, McpMarketEntry, McpServerSummary } from '../src/api/mcp.js';

const api = vi.hoisted(() => ({
  market: vi.fn(),
  detail: vi.fn(),
  install: vi.fn(),
  list: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../src/api/mcp.js', () => ({
  mcpApi: {
    market: api.market,
    marketDetail: api.detail,
    installFromMarket: api.install,
    list: api.list,
  },
}));
vi.mock('../src/lib/notifications/toast.js', () => ({ showToast: api.toast }));
vi.mock('../src/lib/tauri/tauriBridge.js', () => ({ tauriBridge: { openUrl: vi.fn() } }));

const entries: McpMarketEntry[] = ['a', 'b'].map(id => ({
  source: 'official',
  externalId: `io.fixture/${id}`,
  name: `Fixture ${id}`,
  description: 'Local test fixture',
  detailUrl: `https://example.invalid/${id}`,
}));

type InstallResult = Awaited<ReturnType<typeof mcpApi.installFromMarket>>;
let host: HTMLDivElement;
let root: Root;
let servers: McpServerSummary[];
let pending: Map<string, { finish(): void; fail(): void }>;

async function render(visible: boolean): Promise<void> {
  await act(async () => root.render(
    <TooltipProvider>{visible ? <McpMarketPage /> : <div>Other settings page</div>}</TooltipProvider>,
  ));
}

function card(index = 0): HTMLElement {
  const result = [...host.querySelectorAll<HTMLElement>('.ema-card-decorate')]
    .find(element => element.textContent?.includes(entries[index]!.name));
  if (!result) throw new Error(`Missing MCP card ${index}`);
  return result;
}

function addButton(index = 0): HTMLButtonElement {
  const result = [...card(index).querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent === '添加');
  if (!result) throw new Error(`Missing MCP add button ${index}`);
  return result;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  servers = [];
  pending = new Map();
  useMcpStore.setState(useMcpStore.getInitialState(), true);
  api.market.mockResolvedValue({
    items: entries,
    total: 2,
    page: 1,
    pageSize: 40,
    complete: true,
    syncing: false,
  });
  api.detail.mockImplementation(async (_source, externalId) => ({
    ...entries.find(entry => entry.externalId === externalId)!,
    requiredInputs: [],
    config: { type: 'http', url: 'https://example.invalid/mcp' },
  }));
  api.list.mockImplementation(async () => ({ items: [...servers] }));
  api.install.mockImplementation((_source, body: { externalId: string; name: string }) => {
    return new Promise<InstallResult>((resolve, reject) => {
      pending.set(body.externalId, {
        finish() {
          servers.push({
            name: body.name,
            enabled: true,
            connectionStatus: 'connecting',
            toolCount: 0,
            provenance: { sourceKind: 'official', marketEntryId: body.externalId },
            config: { type: 'http', url: 'https://example.invalid/mcp' },
          });
          pending.delete(body.externalId);
          resolve({ id: `fixture-${body.name}`, name: body.name });
        },
        fail() {
          pending.delete(body.externalId);
          reject(new Error('fixture installation failed'));
        },
      });
    });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    for (const operation of pending.values()) operation.fail();
    root.unmount();
  });
  host.remove();
  vi.clearAllMocks();
});

it.each(['stay', 'remount'] as const)('keeps an MCP addition busy with %s', async action => {
  await render(true);
  await act(async () => addButton().click());
  expect(addButton().getAttribute('aria-busy')).toBe('true');
  if (action === 'remount') await render(false);
  await render(true);
  expect.soft(addButton().getAttribute('aria-busy')).toBe('true');
  expect.soft(addButton().disabled).toBe(true);
  await act(async () => pending.get(entries[0]!.externalId)!.finish());
  expect(card().textContent).toContain('已添加');
  expect(api.install).toHaveBeenCalledOnce();
});

it.each(['stay', 'remount'] as const)('keeps concurrent MCP additions independent with %s', async action => {
  await render(true);
  await act(async () => addButton(0).click());
  await act(async () => addButton(1).click());
  expect(pending.size).toBe(2);
  if (action === 'remount') await render(false);
  await render(true);
  expect.soft(addButton(0).getAttribute('aria-busy')).toBe('true');
  expect.soft(addButton(1).getAttribute('aria-busy')).toBe('true');
  await act(async () => pending.get(entries[0]!.externalId)!.finish());
  expect(card(0).textContent).toContain('已添加');
  expect.soft(addButton(1).getAttribute('aria-busy')).toBe('true');
  await act(async () => pending.get(entries[1]!.externalId)!.fail());
  expect(card(0).textContent).toContain('已添加');
  expect(addButton(1).disabled).toBe(false);
  expect(api.toast).toHaveBeenCalledWith('添加失败: fixture installation failed', { variant: 'danger' });
});

it('keeps pending feedback during a market query and reloads completion after remount', async () => {
  await render(true);
  await act(async () => addButton().click());
  const search = host.querySelector<HTMLButtonElement>('form[aria-label="搜索 MCP 服务"] button[type="submit"]')!;
  await act(async () => search.click());
  expect(api.market).toHaveBeenCalledTimes(2);
  expect(addButton().getAttribute('aria-busy')).toBe('true');
  await render(false);
  await act(async () => pending.get(entries[0]!.externalId)!.finish());
  await render(true);
  expect(card().textContent).toContain('已添加');
});

it('deduplicates the same entry after navigation and leaves connection status to the server', async () => {
  await render(true);
  await act(async () => addButton().click());
  await render(false);
  await render(true);
  await act(async () => useMcpStore.getState().addFromMarket('official', {
    externalId: entries[0]!.externalId,
    name: 'Fixture-a',
  }));
  expect(api.install).toHaveBeenCalledOnce();
  await act(async () => pending.get(entries[0]!.externalId)!.finish());
  expect(card().textContent).toContain('已添加');
  expect(useMcpStore.getState().servers[0]?.connectionStatus).toBe('connecting');
  expect(useMcpStore.getState().addingMarketEntryIds.size).toBe(0);
  expect(api.toast).toHaveBeenCalledOnce();
});

it('reports a server list failure separately from successful addition', async () => {
  await render(true);
  await act(async () => addButton().click());
  api.list.mockRejectedValueOnce(new Error('fixture server list unavailable'));
  await act(async () => pending.get(entries[0]!.externalId)!.finish());
  expect(api.toast).toHaveBeenCalledOnce();
  expect(api.toast).toHaveBeenCalledWith(
    '已添加 Fixture-a, 但服务器列表刷新失败: fixture server list unavailable',
    { variant: 'warning' },
  );
  expect(useMcpStore.getState().addingMarketEntryIds.size).toBe(0);
  await act(async () => useMcpStore.getState().refresh());
  expect(card().textContent).toContain('已添加');
  expect(api.install).toHaveBeenCalledOnce();
});

it('does not overwrite the newer server list when an earlier addition refresh finishes late', async () => {
  await render(true);
  await act(async () => addButton(0).click());
  await act(async () => addButton(1).click());
  let finishOld!: (result: { items: McpServerSummary[] }) => void;
  api.list.mockImplementationOnce(() => new Promise(resolve => {
    finishOld = resolve;
  }));
  await act(async () => pending.get(entries[0]!.externalId)!.finish());
  const oldServers = [...servers];
  await act(async () => pending.get(entries[1]!.externalId)!.finish());
  expect(card(1).textContent).toContain('已添加');
  await act(async () => finishOld({ items: oldServers }));
  expect(card(0).textContent).toContain('已添加');
  expect(card(1).textContent).toContain('已添加');
});
