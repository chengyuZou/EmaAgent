// 验证 HTTP Server 只挂载已构造 Router，并统一执行健康检查、认证和 404 协议。

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

const TEST_SECRET = '0123456789abcdef0123456789abcdef';

describe('LocalHost HTTP Server', () => {
  it('不读取业务对象图也能挂载 Router 并统一执行认证', async () => {
    const health = new Hono();
    health.get('/', (context) => context.json({ ok: true }));

    const business = new Hono();
    business.get('/value', (context) => context.json({ value: 42 }));

    const app = buildServer([
      { path: '/health', router: health },
      { path: '/api/example', router: business },
    ], TEST_SECRET);

    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/api/example/value')).status).toBe(401);

    const response = await app.request('/api/example/value', {
      headers: { 'X-Ema-Secret': TEST_SECRET },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: 42 });
  });

  it('未注册路径继续使用统一 404 协议', async () => {
    const app = buildServer([], TEST_SECRET);
    const response = await app.request('/missing', {
      headers: { 'X-Ema-Secret': TEST_SECRET },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});
