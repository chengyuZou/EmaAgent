// 后台进程停止：排队中的同步落终态，运行中的等退出后返回真实终态快照。
import { Hono } from 'hono';
import { z } from 'zod';
import type { BackgroundProcess } from '@ema-agent/tools';
import { processError } from './list.js';
import { jsonBody } from '../validate.js';

export interface BackgroundProcessControlRouteDeps {
  readonly backgroundProcesses: Pick<BackgroundProcess, 'stop'>;
}

const stopBody = z.object({
  sessionId: z.string().min(1),
});

export const backgroundProcessControlRoute = (deps: BackgroundProcessControlRouteDeps) =>
  new Hono()
    .post('/:backgroundProcessId/stop', jsonBody(stopBody), async context => {
      const parsed = context.req.valid('json');
      try {
        const process = await deps.backgroundProcesses.stop(
          parsed.sessionId,
          context.req.param('backgroundProcessId'),
        );
        return context.json({ process });
      } catch (error) {
        return processError(context, error);
      }
    });
