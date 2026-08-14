import { Hono } from 'hono';
import type { Context } from 'hono';

export function healthRoute(): Hono {
  const app = new Hono();

  app.get('/', (c: Context) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      ts: Date.now(),
    });
  });

  return app;
}
