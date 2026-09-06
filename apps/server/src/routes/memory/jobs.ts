import { Hono } from 'hono';
import { z } from 'zod';
import type { MemoryRepo } from '@ema-agent/storage';
import { queryValidator } from '../validate.js';

export interface MemoryJobsRouteDeps {
  readonly jobs: Pick<MemoryRepo, 'listCurrent' | 'listHistory'>;
}

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const memoryJobsRoute = (deps: MemoryJobsRouteDeps) =>
  new Hono()
    .get('/jobs', context => context.json({ items: deps.jobs.listCurrent() }))
    .get('/jobs/history', queryValidator(historyQuery), context => {
      const { limit } = context.req.valid('query');
      return context.json({ items: deps.jobs.listHistory(limit ?? 100) });
    });
