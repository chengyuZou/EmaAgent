// 后台进程读取：Session 隔离的列表与增量输出（游标 + 长轮询 waitMs）。
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BackgroundProcessError, type BackgroundProcess } from '@ema-agent/tools';
import { queryValidator } from '../validate.js';

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

export const backgroundProcessListRoute = (deps: BackgroundProcessListRouteDeps) =>
  new Hono()
    .get('/', queryValidator(listQuery), context => {
      const { sessionId, ...options } = context.req.valid('query');
      return context.json({ items: deps.backgroundProcesses.list(sessionId, options) });
    })
    .get('/:backgroundProcessId/output', queryValidator(outputQuery), async context => {
      const { sessionId, ...options } = context.req.valid('query');
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
