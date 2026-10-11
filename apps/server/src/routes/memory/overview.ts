import { Hono } from 'hono';
import { readMemoryPreviews } from '@ema-agent/memory';

export const memoryOverviewRoute = (deps: { readonly memoryRoot: string }) =>
  new Hono().get('/overview', async context => context.json({
    items: await readMemoryPreviews(deps.memoryRoot, context.req.raw.signal),
  }));
