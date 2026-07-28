// 装配 LocalHost 的认证、请求预算和各业务 HTTP 路由。

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { emaAuth } from './auth.js';
import { healthRoute } from './routes/health.js';
import { permissionRoute } from './routes/permission.js';
import { memoryRoute } from './routes/memory.js';
import { systemEventsRoute } from './routes/system-events.js';
import { settingsRoute } from './routes/settings.js';
import { createSettingsCatalog } from './settings/createSettingsCatalog.js';
import { transcribeRoute } from './routes/transcribe.js';
import { cardsRoute } from './routes/cards.js';
import { diagnosticRoute } from './routes/diagnostic.js';
import { createSkillsRouter }   from './routes/skills.js';
import { createMcpRouter }       from './routes/mcp.js';
import { createMarketRouter }    from './routes/market.js';
import { shellRoute }            from './routes/shell.js';
import { workspaceRoute }        from './routes/workspace.js';
import { kbRoute }               from './routes/knowledge-base.js';
import { agentRunsRoute }            from './routes/agentRuns.js';
import { tasksRoute }             from './routes/tasks.js';
import { storageStatsRoute }     from './routes/storage-stats.js';
import { systemRoute }           from './routes/system.js';
import { requestBudgetMiddleware } from './http/request-budget.js';
import type { AppBindings } from './wiring/index.js';
import { createTurnsRouter } from './wiring/createTurnsRouter.js';
import { createSessionsRouter } from './wiring/createSessionsRouter.js';
import { createProvidersRouter } from './wiring/createProvidersRouter.js';
import { createModelBindingsRouter } from './wiring/createModelBindingsRouter.js';

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
          // 非法 Origin 按不允许处理。
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
  app.route('/api/turns',          createTurnsRouter(bindings));
  app.route('/api/providers',      createProvidersRouter(bindings));
  app.route('/api/model-bindings', createModelBindingsRouter(bindings));
  app.route('/api/storage',        storageStatsRoute(bindings));
  app.route('/api/sessions',       createSessionsRouter(bindings));
  app.route(
    '/api/permission',
    permissionRoute(bindings.permission, bindings.interactionQueue),
  );
  app.route('/api/memory',         memoryRoute(bindings.memory));
  app.route('/api/system/events',  systemEventsRoute(bindings.systemBus));
  app.route('/api/system',         systemRoute(bindings.activeDataDir, bindings.sandboxStatus));
  app.route('/api/system/shell',   shellRoute(bindings));
  app.route('/api/workspace',      workspaceRoute());
  app.route('/api/settings', settingsRoute({
    settings: bindings.settings,
    catalog: createSettingsCatalog(),
    setDefaultPermissionTimeout: timeoutMs => {
      bindings.interactionQueue.setDefaultTimeout(timeoutMs);
    },
  }));
  app.route('/api/diagnostics',    diagnosticRoute());
  app.route('/api/transcribe',     transcribeRoute(bindings));
  app.route('/api/cards',          cardsRoute(bindings));

  app.route('/api',                createSkillsRouter(bindings));
  app.route('/api/mcp',            createMcpRouter(bindings));
  app.route('/api/market',         createMarketRouter(bindings));
  app.route('/api/kb',             kbRoute(bindings));
  app.route(
    '/api/agent-runs',
    agentRunsRoute(bindings.agentRunStore, bindings.agentRunTranscript),
  );
  app.route('/api/tasks', tasksRoute(bindings.taskStore));

  // 404 兜底
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  // 未处理错误兜底
  app.onError((err, c) => {
    console.error('[server] unhandled error', err);
    return c.json({ error: 'internal_server_error', message: err.message }, 500);
  });

  return app;
}
