import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { emaAuth } from './auth.js';
import { healthRoute } from './routes/health.js';
import { turnsRoute } from './routes/turns.js';
import type { AppBindings } from './wiring.js';

export function buildServer(bindings: AppBindings): Hono {
  const app = new Hono();

  // CORS — only localhost origins allowed (no external access)
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return origin;
        try {
          const url = new URL(origin);
          if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return origin;
        } catch {
          // ignore
        }
        return null;
      },
      credentials: true,
    }),
  );

  // Auth middleware — validates X-Ema-Secret on all non-health routes
  app.use('*', emaAuth());

  // Routes
  app.route('/health', healthRoute());
  app.route('/api/turns', turnsRoute(bindings));

  // 404 fallback
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  // Unhandled error fallback
  app.onError((err, c) => {
    console.error('[server] unhandled error', err);
    return c.json({ error: 'internal_server_error', message: err.message }, 500);
  });

  return app;
}
