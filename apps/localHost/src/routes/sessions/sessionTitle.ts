// 把 Session 标题生成用例暴露为轻量 HTTP 动作。
import { Hono } from 'hono';
import { asSessionId } from '@ema-agent/ids';
import type { SessionTitleGenerator } from '@ema-agent/session';

export function sessionTitleRoute(
  titleGenerator: Pick<SessionTitleGenerator, 'generate'>,
): Hono {
  const app = new Hono();

  app.post('/:id/title', async (c) => {
    try {
      const title = await titleGenerator.generate(asSessionId(c.req.param('id')));
      return title ? c.json({ title }) : c.body(null, 204);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('session_not_found')) {
        return c.json({ error: 'session_not_found' }, 404);
      }
      throw error;
    }
  });

  return app;
}
