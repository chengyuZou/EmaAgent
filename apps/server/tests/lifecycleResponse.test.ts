import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

describe('server HTTP adapter global Response preservation', () => {
  it('preserves native global Response and Request when overrideGlobalObjects is false', async () => {
    const originalResponse = globalThis.Response;
    const originalRequest = globalThis.Request;

    const app = new Hono();
    app.post('/oauth/token', context => {
      return context.json(
        { error: 'invalid_grant', error_description: 'code_verifier mismatch' },
        400,
      );
    });

    const httpServer = serve({
      fetch: app.fetch,
      port: 0,
      hostname: '127.0.0.1',
      overrideGlobalObjects: false,
    }) as Server;

    try {
      await new Promise<void>(resolve => {
        if (httpServer.listening) resolve();
        else httpServer.once('listening', () => resolve());
      });
      const address = httpServer.address() as AddressInfo;

      expect(globalThis.Response).toBe(originalResponse);
      expect(globalThis.Request).toBe(originalRequest);

      const response = await fetch(`http://127.0.0.1:${address.port}/oauth/token`, {
        method: 'POST',
      });
      // Third-party fetch callers such as MCP SDK parseErrorResponse rely on `instanceof Response`.
      expect(response instanceof originalResponse).toBe(true);
      expect(response instanceof globalThis.Response).toBe(true);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'invalid_grant',
        error_description: 'code_verifier mismatch',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => (error ? reject(error) : resolve()));
      });
    }
  });
});
