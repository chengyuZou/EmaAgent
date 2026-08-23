// 记忆后台任务：列表、重试与取消。任务由 Turn 终态自动入队或维护端点手动触发。
import { Hono } from 'hono';
import { z } from 'zod';
import type { JobAdmin } from '@ema-agent/memory';
import type { MemoryJobsRepo } from '@ema-agent/storage';

export interface MemoryJobsRouteDeps {
  readonly jobs: Pick<MemoryJobsRepo, 'listRecent' | 'listPaths' | 'findById'>;
  readonly admin: Pick<JobAdmin, 'retry' | 'cancel'>;
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function memoryJobsRoute(deps: MemoryJobsRouteDeps): Hono {
  const app = new Hono();

  app.get('/jobs', context => {
    const parsed = listQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    return context.json({ items: deps.jobs.listRecent(parsed.data.limit ?? 100) });
  });

  app.get('/jobs/:id/paths', context => {
    const job = deps.jobs.findById(context.req.param('id'));
    if (!job) return context.json({ error: 'job_not_found' }, 404);
    return context.json({ items: deps.jobs.listPaths(job.id) });
  });

  // 只有 failed 可重试；重试复制一条新 pending，原行保留为失败记录。
  app.post('/jobs/:id/retry', context => {
    const retried = deps.admin.retry(context.req.param('id'));
    if (!retried) return context.json({ error: 'job_not_retryable' }, 409);
    return context.json(retried, 201);
  });

  app.post('/jobs/:id/cancel', context => {
    const cancelled = deps.admin.cancel(context.req.param('id'));
    if (!cancelled) return context.json({ error: 'job_not_cancellable' }, 409);
    return context.json({ ok: true });
  });

  return app;
}
