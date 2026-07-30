// 提供后台 Shell 的 Session 隔离列表、增量输出和停止接口，供后续进程面板使用。

import { Hono } from 'hono';
import { z } from 'zod';
import {
  asBackgroundProcessId,
  asSessionId,
} from '@ema-agent/ids';
import type { BackgroundProcessPort } from '@ema-agent/tools';

const listQuerySchema = z.object({
  sessionId: z.string().uuid(),
  status: z.enum([
    'queued',
    'running',
    'completed',
    'failed',
    'timedOut',
    'stopped',
    'interrupted',
  ]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const outputQuerySchema = z.object({
  sessionId: z.string().uuid(),
  cursor: z.string().max(200).optional(),
  waitMs: z.coerce.number().int().min(0).max(30_000).default(0),
});

const stopBodySchema = z.object({
  sessionId: z.string().uuid(),
}).strict();

const processPathSchema = z.object({
  backgroundProcessId: z.string().uuid(),
});

export function backgroundProcessesRoute(
  processes: BackgroundProcessPort,
): Hono {
  const app = new Hono();

  app.get('/', (context) => {
    const parsed = listQuerySchema.safeParse(context.req.query());
    if (!parsed.success) return invalidRequest(context, parsed.error);
    const { sessionId, status, limit } = parsed.data;
    return context.json({
      processes: processes.list(asSessionId(sessionId), { status, limit }),
    });
  });

  app.get('/:backgroundProcessId/output', async (context) => {
    const parsed = outputQuerySchema.safeParse(context.req.query());
    if (!parsed.success) return invalidRequest(context, parsed.error);
    const path = processPathSchema.safeParse(context.req.param());
    if (!path.success) return invalidRequest(context, path.error);
    try {
      return context.json(await processes.readOutput(
        asSessionId(parsed.data.sessionId),
        asBackgroundProcessId(path.data.backgroundProcessId),
        {
          cursor: parsed.data.cursor,
          waitMs: parsed.data.waitMs,
        },
      ));
    } catch (error) {
      return processError(context, error);
    }
  });

  app.post('/:backgroundProcessId/stop', async (context) => {
    const path = processPathSchema.safeParse(context.req.param());
    if (!path.success) return invalidRequest(context, path.error);
    const parsed = stopBodySchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return invalidRequest(context, parsed.error);
    try {
      return context.json({
        process: processes.stop(
          asSessionId(parsed.data.sessionId),
          asBackgroundProcessId(path.data.backgroundProcessId),
        ),
      });
    } catch (error) {
      return processError(context, error);
    }
  });

  return app;
}

function invalidRequest(
  context: { json(body: unknown, status: 400): Response },
  error: z.ZodError,
): Response {
  return context.json({
    error: 'invalid_request',
    details: error.flatten(),
  }, 400);
}

function processError(
  context: {
    json(body: unknown, status: 404 | 409): Response;
  },
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not found in the current Session')) {
    return context.json({ error: 'not_found' }, 404);
  }
  return context.json({ error: 'process_state_conflict', message }, 409);
}
