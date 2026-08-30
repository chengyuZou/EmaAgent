// 验证 Desktop WebView 的 CORS 预检可达，而真正的 Server 请求仍受共享密钥保护。
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { emaAuth, localWebviewCors } from '../src/platform/auth.js';

const SECRET = 's'.repeat(32);

function createApp(): Hono {
  return new Hono()
    .use('*', localWebviewCors())
    .use('*', emaAuth(SECRET))
    .get('/api/system/events', context => context.text('connected'));
}

describe('Desktop WebView access', () => {
  it('allows the authenticated header through CORS preflight before auth runs', async () => {
    const response = await createApp().request('/api/system/events', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:1420',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-ema-secret',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:1420');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Ema-Secret');
  });

  it('still rejects a real request without the shared secret', async () => {
    const response = await createApp().request('/api/system/events', {
      headers: { Origin: 'http://127.0.0.1:1420' },
    });

    expect(response.status).toBe(401);
  });

  it('accepts a real request with the shared secret', async () => {
    const response = await createApp().request('/api/system/events', {
      headers: {
        Origin: 'http://127.0.0.1:1420',
        'X-Ema-Secret': SECRET,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('connected');
  });
});
