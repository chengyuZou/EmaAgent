// 后台进程读取：Session 隔离的列表与增量输出（游标 + 长轮询 waitMs）。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BackgroundProcessError, type BackgroundProcess } from '@ema-agent/tools';

export interface BackgroundProcessListRouteDeps {
  readonly backgroundProcesses: Pick<BackgroundProcess, 'list' | 'readOutput'>;
}

const listQuery = z.object({
  sessionId: z.string().min(1),
  status: z.enum([
    'queued',
    'running',
    'completed',
    'failed',
    'timedOut',
    'stopped',
    'interrupted',
  ]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const outputQuery = z.object({
  sessionId: z.string().min(1),
  cursor: z.string().max(200).optional(),
  waitMs: z.coerce.number().int().min(0).max(30_000).optional(),
});

export function backgroundProcessListRoute(deps: BackgroundProcessListRouteDeps): Hono {
  const app = new Hono();

  app.get('/', context => {
    const parsed = listQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const { sessionId, ...options } = parsed.data;
    return context.json({ items: deps.backgroundProcesses.list(sessionId, options) });
  });

  app.get('/:backgroundProcessId/output', async context => {
    const parsed = outputQuery.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const { sessionId, ...options } = parsed.data;
    try {
      return context.json(await deps.backgroundProcesses.readOutput(
        sessionId,
        context.req.param('backgroundProcessId'),
        options,
      ));
    } catch (error) {
      return processError(context, error);
    }
  });

  return app;
}

export function processError(context: Context, error: unknown): Response {
  if (error instanceof BackgroundProcessError) {
    if (error.code === 'not_found') {
      return context.json({ error: 'process_not_found', message: error.message }, 404);
    }
    if (error.code === 'invalid_cursor') {
      return context.json({ error: 'invalid_cursor', message: error.message }, 400);
    }
    return context.json({ error: error.code, message: error.message }, 409);
  }
  throw error;
}
