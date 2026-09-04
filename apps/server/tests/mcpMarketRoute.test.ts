// 验证 MCP 市场 Route 把来源和带斜杠的外部条目身份完整交给领域服务.

import { describe, expect, it, vi } from 'vitest';
import { hc } from 'hono/client';
import type { McpMarketService } from '@ema-agent/mcp';
import { mcpMarketRoute } from '../src/routes/mcp/market.js';

describe('MCP market route', () => {
  it('按 source 读取列表并通过 query 完整接收带斜杠的 externalId', async () => {
    const load = vi.fn(async () => ({ items: [] }));
    const detail = vi.fn(async () => null);
    const market = {
      load,
      refresh: vi.fn(),
      detail,
      install: vi.fn(),
    } as unknown as Pick<McpMarketService, 'load' | 'refresh' | 'detail' | 'install'>;
    const app = mcpMarketRoute({ market });
    const client = hc<typeof app>('http://local', {
      fetch: (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init)),
    });

    const listResponse = await app.request('/market/official?q=file&page=3');
    const detailResponse = await client.market[':source'].detail.$get({
      param: { source: 'official' },
      query: { externalId: 'io.example/server' },
    });

    expect(listResponse.status).toBe(200);
    expect(load).toHaveBeenCalledWith('official', 'file', 3, expect.any(AbortSignal));
    expect(detailResponse.status).toBe(404);
    expect(detail).toHaveBeenCalledWith('official', 'io.example/server', expect.any(AbortSignal));
  });
});
