import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebRequests } from '../webRequests.js';
import { WebFetchTool } from '../tools/WebFetchTool/WebFetchTool.js';
import { WebSearchTool } from '../tools/WebSearchTool/WebSearchTool.js';
import { clearWebFetchCache } from '../tools/WebFetchTool/cache.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearWebFetchCache();
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  cleanups.length = 0;
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return address.port;
}

function requests(env: NodeJS.ProcessEnv = {}) {
  const client = createWebRequests(env);
  cleanups.push(() => client.close());
  return client.request;
}

function options() {
  return { signal: AbortSignal.timeout(3_000), redirect: 'follow' as const };
}

describe('web requests', () => {
  it('uses the configured proxy, rechecks bypass after a redirect, and leaves ordinary fetch alone', async () => {
    let directRequests = 0;
    const target = createServer((_request, response) => {
      directRequests += 1;
      response.end('direct');
    });
    const targetPort = await listen(target);
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (request, socket) => {
      tunnels.push(request.url!);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () => {
        socket.end(
          'HTTP/1.1 302 Found\r\n'
          + `Location: http://127.0.0.1:${targetPort}/final\r\n`
          + 'Content-Length: 0\r\nConnection: close\r\n\r\n',
        );
      });
    });
    const proxyPort = await listen(proxy);
    const request = requests({
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: '127.0.0.1',
    });
    const result = await request('http://unresolvable.invalid/start', options());
    expect(await result.text()).toBe('direct');
    expect(tunnels).toEqual(['unresolvable.invalid:80']);
    expect(await (await fetch(`http://127.0.0.1:${targetPort}/ordinary`)).text()).toBe('direct');
    expect(directRequests).toBe(2);
    expect(tunnels).toHaveLength(1);
  });

  it('does not retry direct when the proxy refuses the connection', async () => {
    const unavailablePort = await listen(createServer());
    await cleanups.pop()!();
    let directRequests = 0;
    const targetPort = await listen(createServer((_request, response) => {
      directRequests += 1;
      response.end('must not reach this');
    }));
    const request = requests({ HTTP_PROXY: `http://127.0.0.1:${unavailablePort}` });
    await expect(request(`http://127.0.0.1:${targetPort}/`, options()))
      .rejects.toMatchObject({ code: 'web/connection_refused' });
    expect(directRequests).toBe(0);
  });

  it('reads native fixed proxy settings and honors Windows wildcard bypass', async () => {
    const proxy = createServer();
    const tunnels: string[] = [];
    proxy.on('connect', (request, socket) => {
      tunnels.push(request.url!);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
    const port = await listen(proxy);
    const request = requests({
      EMA_WEB_SYSTEM_PROXY: JSON.stringify({
        proxy: `http=127.0.0.1:${port};https=127.0.0.1:${port}`,
        bypass: '*.invalid;<local>',
        automatic: false,
        readFailed: false,
      }),
    });
    await expect(request('http://bypass.invalid/', options())).rejects.toMatchObject({
      code: 'web/dns',
    });
    expect(tunnels).toEqual([]);
    await expect(request('https://example.org/', options())).rejects.toThrow();
    expect(tunnels).toEqual(['example.org:443']);
  });

  it('explicit environment proxy overrides automatic system settings', async () => {
    const port = await listen(createServer((_request, response) => response.end('bypassed')));
    const automatic = JSON.stringify({
      proxy: '', bypass: '', automatic: true, readFailed: false,
    });
    await expect(requests({ EMA_WEB_SYSTEM_PROXY: automatic })(
      `http://127.0.0.1:${port}/`, options(),
    )).rejects.toMatchObject({ code: 'web/proxy_configuration' });
    const request = requests({
      HTTP_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: '127.0.0.1',
      EMA_WEB_SYSTEM_PROXY: automatic,
    });
    expect(await (await request(`http://127.0.0.1:${port}/`, options())).text()).toBe('bypassed');
  });

  it('preserves a nested connection timeout through the actual WebFetch context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', {
      cause: Object.assign(new Error('secret endpoint and credentials'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      }),
    })));
    const request = requests();
    const context = WebFetchTool.validateContext({
      cwd: '', platform: process.platform, webRequest: request,
    });
    if (!context.valid) throw new Error('Expected the web request capability');
    await expect(WebFetchTool.execute(
      WebFetchTool.inputSchema.parse({ url: 'https://example.org/' }),
      context.context,
      { sessionId: 's', turnId: 't', toolCallId: 'c', signal: options().signal },
    )).rejects.toMatchObject({
      code: 'web/connect_timeout',
      message: expect.not.stringContaining('secret endpoint'),
    });
  });

  it('reports HTTP status and Retry-After without downloading an unbounded error page', async () => {
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('Rate limited. '.repeat(1_000)));
      },
      cancel() { cancelled = true; },
    }), {
      status: 429,
      headers: { 'content-type': 'text/plain', 'retry-after': '120' },
    })));
    await expect(requests()('https://example.org/', options())).rejects.toMatchObject({
      code: 'web/http_429',
      message: expect.stringContaining('Retry-After: 120 seconds'),
    });
    expect(cancelled).toBe(true);
  });

  it('keeps caller cancellation instead of turning it into a connection failure', async () => {
    const controller = new AbortController();
    const reason = new Error('Turn cancelled');
    controller.abort(reason);
    await expect(requests()('https://example.org/', {
      signal: controller.signal, redirect: 'follow',
    })).rejects.toBe(reason);
  });

  it('Brave keeps manual redirects, redacts the API key, and preserves HTTP errors', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'private-brave-token');
    const mock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'Invalid key: private-brave-token' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', mock);
    await expect(WebSearchTool.execute(
      WebSearchTool.inputSchema.parse({ query: 'synthetic test' }),
      requests(),
      { sessionId: 's', turnId: 't', toolCallId: 'c', signal: options().signal },
    )).rejects.toMatchObject({
      code: 'web/http_401',
      message: expect.not.stringContaining('private-brave-token'),
    });
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining('api.search.brave.com'),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('HTTP error excerpts stop waiting while preserving status', async () => {
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      pull() {},
      cancel() { cancelled = true; },
    }), { status: 403, headers: { 'content-type': 'text/html' } })));
    await expect(requests()('https://example.org/', options()))
      .rejects.toMatchObject({ code: 'web/http_403' });
    expect(cancelled).toBe(true);
  });
});
