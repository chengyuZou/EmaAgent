// 装配 LocalHost 的认证、请求预算和已经构造完成的 HTTP 路由。

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { emaAuth } from './auth.js';
import { requestBudgetMiddleware } from './http/request-budget.js';

export interface MountedHttpRoute {
  readonly path: string;
  readonly router: Hono;
}

export function buildServer(
  routes: readonly MountedHttpRoute[],
  sharedSecret: string,
): Hono {
  const app = new Hono();

  // 仅允许本机页面访问 LocalHost，非法或外部 Origin 不进入业务路由。
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

  // 认证和传输预算在所有业务 Router 之前执行；业务内部仍校验解码后的真实值。
  app.use('*', emaAuth(sharedSecret));
  app.use('*', requestBudgetMiddleware());

  for (const route of routes) {
    app.route(route.path, route.router);
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('[server] unhandled error', err);
    return c.json({ error: 'internal_server_error', message: err.message }, 500);
  });

  return app;
}
