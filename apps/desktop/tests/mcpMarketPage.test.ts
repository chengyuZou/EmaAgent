// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMcpStore } from '../src/stores/mcp.js';
import { McpMarketPage } from '../src/settings/mcp/McpMarketPage.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/api/mcp.js', () => ({
  mcpApi: {
    market: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 40, complete: true, syncing: false })),
    marketDetail: vi.fn(),
    installFromMarket: vi.fn(),
  },
}));

vi.mock('../src/lib/tauri-bridge.js', () => ({
  tauriBridge: { openUrl: vi.fn() },
}));

vi.mock('../src/lib/system-event-dispatcher.js', () => ({
  MCP_MARKET_CHANGED_EVENT: 'ema:mcp-market-changed',
}));

vi.mock('../src/lib/toast.js', () => ({ showToast: vi.fn() }));

describe('McpMarketPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useMcpStore.setState({
      servers: [],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('市场页面读取后端分页结果', async () => {
    await act(async () => {
      root.render(createElement(McpMarketPage));
    });
    expect(document.body.textContent).toContain('暂无市场条目');
  });
});
