import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  emaAuth,
  MissingSharedSecretError,
  requireSharedSecret,
} from '../src/auth.js';

const TEST_SECRET = '0123456789abcdef0123456789abcdef';

function createProtectedApp(): Hono {
  const app = new Hono();
  app.use('*', emaAuth(TEST_SECRET));
  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/private', (c) => c.json({ value: 'private' }));
  return app;
}

describe('Core Sidecar 认证', () => {
  it('启动期缺少密钥时 fail-closed', () => {
    expect(() => requireSharedSecret({})).toThrow(MissingSharedSecretError);
    expect(() => requireSharedSecret({ EMA_SHARED_SECRET: 'too-short' }))
      .toThrow(MissingSharedSecretError);
  });

  it('健康检查公开，但业务路由必须携带正确密钥', async () => {
    const app = createProtectedApp();

    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/private')).status).toBe(401);
    expect((await app.request('/private', {
      headers: { 'X-Ema-Secret': 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    })).status).toBe(401);
    expect((await app.request('/private', {
      headers: { 'X-Ema-Secret': TEST_SECRET },
    })).status).toBe(200);
  });

  it('拒绝响应禁止缓存', async () => {
    const response = await createProtectedApp().request('/private');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
