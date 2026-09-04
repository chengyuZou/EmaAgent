import { Hono } from 'hono';
import { z } from 'zod';
import { MCP_MARKET_SOURCES, type McpMarketService } from '@ema-agent/mcp';
import { jsonBody, queryValidator } from '../validate.js';

export interface McpMarketRouteDeps {
  readonly market: Pick<McpMarketService, 'load' | 'refresh' | 'detail' | 'install'>;
}

const installBody = z.object({
  externalId: z.string().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  inputs: z.record(z.string(), z.string()).optional(),
});
const sourceParam = z.enum(MCP_MARKET_SOURCES);
const listQuery = z.object({
  q: z.string().trim().max(200).default(''),
  page: z.coerce.number().int().min(1).default(1),
});
const detailQuery = z.object({
  externalId: z.string().min(1),
});

export const mcpMarketRoute = (deps: McpMarketRouteDeps) => new Hono()
  .get('/market/:source', queryValidator(listQuery), async context => {
    const source = sourceParam.parse(context.req.param('source'));
    const query = context.req.valid('query');
    return context.json(await deps.market.load(source, query.q, query.page, context.req.raw.signal));
  })
  .post('/market/:source/refresh', async context => {
    try {
      const source = sourceParam.parse(context.req.param('source'));
      return context.json({ total: await deps.market.refresh(source, context.req.raw.signal) });
    } catch (error) {
      return context.json({ error: 'market_refresh_failed', message: messageOf(error) }, 502);
    }
  })
  .get('/market/:source/detail', queryValidator(detailQuery), async context => {
    const source = sourceParam.parse(context.req.param('source'));
    const detail = await deps.market.detail(
      source,
      context.req.valid('query').externalId,
      context.req.raw.signal,
    );
    return detail ? context.json(detail) : context.json({ error: 'market_entry_not_found' }, 404);
  })
  .post('/market/:source/install', jsonBody(installBody), async context => {
    try {
      const source = sourceParam.parse(context.req.param('source'));
      return context.json(await deps.market.install({
        source,
        ...context.req.valid('json'),
        signal: context.req.raw.signal,
      }), 201);
    } catch (error) {
      return context.json({ error: 'market_install_failed', message: messageOf(error) }, 422);
    }
  });

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
