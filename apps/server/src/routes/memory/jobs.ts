// 记忆后台任务：列表、重试与取消。任务由 Turn 终态自动入队或维护端点手动触发。
import { Hono } from 'hono';
import { z } from 'zod';
import type { JobAdmin } from '@ema-agent/memory';
import type { MemoryJobsRepo } from '@ema-agent/storage';
import { queryValidator } from '../validate.js';

export interface MemoryJobsRouteDeps {
  readonly jobs: Pick<MemoryJobsRepo, 'listRecent' | 'listPaths' | 'listBusyPaths' | 'findById'>;
  readonly admin: Pick<JobAdmin, 'retry' | 'cancel'>;
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const memoryJobsRoute = (deps: MemoryJobsRouteDeps) =>
  new Hono()
    .get('/jobs', queryValidator(listQuery), context => {
      const { limit } = context.req.valid('query');
      return context.json({ items: deps.jobs.listRecent(limit ?? 100) });
    })
    // 编辑锁事实源：running 整合 Job 正在改动的准确路径（前端据此禁用编辑）。
    .get('/jobs/busy-paths', context => {
      return context.json({ items: deps.jobs.listBusyPaths() });
    })
    .get('/jobs/:id/paths', context => {
      const job = deps.jobs.findById(context.req.param('id'));
      if (!job) return context.json({ error: 'job_not_found' }, 404);
      return context.json({ items: deps.jobs.listPaths(job.id) });
    })
    // 只有 failed 可重试；重试复制一条新 pending，原行保留为失败记录。
    .post('/jobs/:id/retry', context => {
      const retried = deps.admin.retry(context.req.param('id'));
      if (!retried) return context.json({ error: 'job_not_retryable' }, 409);
      return context.json(retried, 201);
    })
    .post('/jobs/:id/cancel', context => {
      const cancelled = deps.admin.cancel(context.req.param('id'));
      if (!cancelled) return context.json({ error: 'job_not_cancellable' }, 409);
      return context.json({ ok: true });
    });
