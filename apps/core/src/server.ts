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
import { createMarketRouter }    from './routes/market.js';
import { shellRoute }            from './routes/shell.js';
import { workspaceRoute }        from './routes/workspace.js';
import { kbRoute }               from './routes/knowledge-base.js';
import { agentTasksRoute }       from './routes/agent-tasks.js';
import { storageStatsRoute }     from './routes/storage-stats.js';
import { systemRoute }           from './routes/system.js';
import { requestBudgetMiddleware } from './http/request-budget.js';
import type { AppBindings } from './wiring/index.js';

export function buildServer(bindings: AppBindings, sharedSecret: string): Hono {
  const app = new Hono();

  // CORS — 仅允许 localhost 源(禁止外部访问)
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

  // Auth 中间件 — 所有非 health 路由校验 X-Ema-Secret
  app.use('*', emaAuth(sharedSecret));

  // 在任何 JSON/multipart 解析前统一执行传输预算；各业务 Facade 继续校验
  // 解码后的真实字节、数量和时长，形成两道独立防线。
  app.use('*', requestBudgetMiddleware());

  // 路由
  app.route('/health', healthRoute());
  app.route('/api/turns',          turnsRoute(bindings));
  app.route('/api/providers',      providersRoute(bindings));
  app.route('/api/model-bindings', modelBindingsRoute(bindings));
  app.route('/api/storage',        storageStatsRoute(bindings));
  app.route('/api/sessions',       sessionsRoute(bindings));
  app.route('/api/permission',     permissionRoute(bindings));
  app.route('/api/memory',         memoryRoute(bindings));
  app.route('/api/system/events',  systemEventsRoute(bindings));
  app.route('/api/system',         systemRoute(bindings));
  app.route('/api/system/shell',   shellRoute(bindings));
  app.route('/api/workspace',      workspaceRoute());
  app.route('/api/settings',       settingsRoute(bindings));
  app.route('/api/diagnostics',    diagnosticRoute());
  app.route('/api/transcribe',     transcribeRoute(bindings));
  app.route('/api/cards',          cardsRoute(bindings));

  // Artifact 路由:V1 默认不挂载(releaseFeatures.artifacts === true 时才挂)。
  // 源码保留(routes/artifacts.ts),V1.5 完成状态机(B-003/B-068/B-069)后启用。
  if (bindings.releaseFeatures.artifacts) {
    app.route('/api', createArtifactsRouter(bindings));
  }

  app.route('/api',                createSkillsRouter(bindings));
  app.route('/api/mcp',            createMcpRouter(bindings));
  app.route('/api/market',         createMarketRouter(bindings));
  app.route('/api/kb',             kbRoute(bindings));
  app.route('/api/agent-tasks',    agentTasksRoute(bindings));

  // 404 兜底
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  // 未处理错误兜底
  app.onError((err, c) => {
    console.error('[server] unhandled error', err);
    return c.json({ error: 'internal_server_error', message: err.message }, 500);
  });

  return app;
}
