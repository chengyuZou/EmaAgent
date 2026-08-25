// /compact 命令路由：手动压缩 Session 历史；业务链全部在 @ema-agent/commands。
// 停止不走这里——Session 级停止统一在 sessions/actions 的 /:sessionId/abort。
import { Hono } from 'hono';
import { CommandsError, type CommandCompactResult } from '@ema-agent/commands';
import { SessionBusyError } from '@ema-agent/session';

export function commandsCompactRoute(deps: {
  readonly compactSession: (sessionId: string) => Promise<CommandCompactResult>;
}): Hono {
  const app = new Hono();

  app.post('/:sessionId/compact', async context => {
    const sessionId = context.req.param('sessionId');
    try {
      return context.json(await deps.compactSession(sessionId));
    } catch (error) {
      if (error instanceof SessionBusyError) {
        return context.json({ error: 'session_busy', message: error.message }, 409);
      }
      if (error instanceof CommandsError) {
        if (error.code === 'compact_failed') {
          return context.json({ error: 'compact_failed', message: error.message }, 500);
        }
        return context.json({ error: error.code.replace('/', '_'), message: error.message }, 409);
      }
      if (errorMessageStartsWith(error, 'session_not_found')) {
        return context.json({ error: 'session_not_found' }, 404);
      }
      throw error;
    }
  });

  return app;
}

function errorMessageStartsWith(error: unknown, prefix: string): boolean {
  return error instanceof Error && error.message.startsWith(prefix);
}
