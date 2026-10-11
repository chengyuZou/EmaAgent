import { Hono } from 'hono';
import { z } from 'zod';
import type { MemoryRepo } from '@ema-agent/storage';
import { paramValidator, queryValidator } from '../validate.js';

export interface MemoryJobsRouteDeps {
  readonly jobs: Pick<MemoryRepo,
    'listPage' | 'listRecent' | 'findDetail'
    | 'ignoreFailure' | 'ignoreAllFailures'
  >;
}

const RECENT_JOB_COUNT = 3;
const jobParams = z.object({ id: z.string().min(1).max(256) });
const jobQuery = z.object({
  startAt: z.coerce.number().int().nonnegative().optional(),
  endAt: z.coerce.number().int().nonnegative().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  cursorCreatedAt: z.coerce.number().int().nonnegative().optional(),
  cursorId: z.string().min(1).max(256).optional(),
  cursorDirection: z.enum(['next', 'previous']).optional(),
}).refine(value => (
  value.startAt === undefined || value.endAt === undefined || value.startAt < value.endAt
), { message: 'startAt must be before endAt' }).refine(value => {
  const fields = [value.cursorCreatedAt, value.cursorId, value.cursorDirection];
  return fields.every(field => field === undefined) || fields.every(field => field !== undefined);
}, { message: 'Cursor requires createdAt, id and direction' });

export const memoryJobsRoute = (deps: MemoryJobsRouteDeps) =>
  new Hono()
    .get('/jobs', queryValidator(jobQuery), context => {
      const query = context.req.valid('query');
      return context.json(deps.jobs.listPage({
        startAt: query.startAt,
        endAt: query.endAt,
        order: query.order,
        page: query.page,
        cursor: query.cursorId !== undefined
          ? {
              createdAt: query.cursorCreatedAt!,
              id: query.cursorId,
              direction: query.cursorDirection!,
            }
          : undefined,
      }));
    })
    .get('/jobs/recent', context => context.json({
      items: deps.jobs.listRecent(RECENT_JOB_COUNT),
    }))
    .get('/jobs/:id', paramValidator(jobParams), context => {
      const item = deps.jobs.findDetail(context.req.valid('param').id);
      return item
        ? context.json({ item })
        : context.json({ error: 'memory_job_not_found' }, 404);
    })
    .post('/jobs/ignore-all', context => {
      deps.jobs.ignoreAllFailures();
      return context.body(null, 204);
    })
    .post('/jobs/:id/ignore', paramValidator(jobParams), context => {
      if (!deps.jobs.ignoreFailure(context.req.valid('param').id)) {
        return context.json({ error: 'failed_memory_job_not_found' }, 404);
      }
      return context.body(null, 204);
    });
