import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { emaAuth } from './auth.js';
import { healthRoute } from './routes/health.js';
import { turnsRoute } from './routes/turns.js';
import { providersRoute } from './routes/providers.js';
import { modelBindingsRoute } from './routes/model-bindings.js';
import { sessionsRoute } from './routes/sessions.js';
import { permissionRoute } from './routes/permission.js';
import { memoryRoute } from './routes/memory.js';
import { systemEventsRoute } from './routes/system-events.js';
import { settingsRoute } from './routes/settings.js';
import { transcribeRoute } from './routes/transcribe.js';
import { cardsRoute } from './routes/cards.js';
import { diagnosticRoute } from './routes/diagnostic.js';
import { createArtifactsRouter } from './routes/artifacts.js';
import { createSkillsRouter }   from './routes/skills.js';
import { createMcpRouter }       from './routes/mcp.js';
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
  app.route('/api/turns',          turnsRoute(bindings));
  app.route('/api/providers',      providersRoute(bindings));
  app.route('/api/model-bindings', modelBindingsRoute(bindings));
  app.route('/api/sessions',       sessionsRoute(bindings));
  app.route('/api/permission',     permissionRoute(bindings));
  app.route('/api/memory',         memoryRoute(bindings));
  app.route('/api/system/events',  systemEventsRoute(bindings));
  app.route('/api/settings',       settingsRoute(bindings));
  app.route('/api/diagnostics',    diagnosticRoute());
  app.route('/api/transcribe',     transcribeRoute(bindings));
  app.route('/api/cards',          cardsRoute(bindings));
  app.route('/api',                createArtifactsRouter(bindings));
  app.route('/api',                createSkillsRouter(bindings));
  app.route('/api/mcp',            createMcpRouter(bindings));

  // 404 fallback
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  // Unhandled error fallback
  app.onError((err, c) => {
    console.error('[server] unhandled error', err);
    return c.json({ error: 'internal_server_error', message: err.message }, 500);
  });

  return app;
}
