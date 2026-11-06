import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { emaAuth, localWebviewCors, takeSharedSecret } from '../src/platform/auth.js';

const SECRET = 's'.repeat(32);

function createApp(): Hono {
  return new Hono()
    .use('*', localWebviewCors())
    .use('*', emaAuth(SECRET))
    .get('/api/system/events', context => context.text('connected'));
}

describe('Desktop WebView access', () => {
  it('启动后从环境移除口令, 已取得的口令仍可用于认证', async () => {
    const environment = { EMA_SHARED_SECRET: SECRET, ema_shared_secret: SECRET, OTHER: 'keep' };
    const secret = takeSharedSecret(environment);
    expect(environment).toEqual({ OTHER: 'keep' });
    const app = new Hono().use('*', emaAuth(secret)).get('/', context => context.text('ok'));
    expect((await app.request('/', { headers: { 'X-Ema-Secret': SECRET } })).status).toBe(200);
  });
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

  it('accepts the loopback WebSocket handshake secret from its query string', async () => {
    const response = await createApp().request(`/api/system/events?secret=${SECRET}`, {
      headers: { Upgrade: 'websocket' },
    });

    expect(response.status).toBe(200);
  });

  it('accepts a query secret only for the local audio GET, not general file reading or mutations', async () => {
    const app = createApp()
      .get('/api/workspaces/files/audio', context => context.text('audio'))
      .get('/api/workspaces/files/file', context => context.text('file'))
      .post('/api/workspaces/files/audio', context => context.text('post'));
    expect((await app.request(`/api/workspaces/files/audio?secret=${SECRET}`)).status).toBe(200);
    expect((await app.request(`/api/workspaces/files/file?secret=${SECRET}`)).status).toBe(401);
    expect((await app.request(`/api/workspaces/files/audio?secret=${SECRET}`, { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/workspaces/files/audio')).status).toBe(401);
    expect((await app.request(`/api/workspaces/files/audio?secret=${SECRET}`, {
      headers: { 'X-Ema-Secret': 'wrong-secret' },
    })).status).toBe(401);
  });
});
