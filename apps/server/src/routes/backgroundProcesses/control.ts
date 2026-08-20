// 后台进程停止：排队中的同步落终态，运行中的等退出后返回真实终态快照。
import { Hono } from 'hono';
import { z } from 'zod';
import type { BackgroundProcess } from '@ema-agent/tools';
import { processError } from './list.js';

export interface BackgroundProcessControlRouteDeps {
  readonly backgroundProcesses: Pick<BackgroundProcess, 'stop'>;
}

const stopBody = z.object({
  sessionId: z.string().min(1),
});

export function backgroundProcessControlRoute(deps: BackgroundProcessControlRouteDeps): Hono {
  const app = new Hono();

  app.post('/:backgroundProcessId/stop', async context => {
    const parsed = stopBody.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    try {
      const process = await deps.backgroundProcesses.stop(
        parsed.data.sessionId,
        context.req.param('backgroundProcessId'),
      );
      return context.json({ process });
    } catch (error) {
      return processError(context, error);
    }
  });

  return app;
}
