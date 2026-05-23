/**
 * sidecar-client.test.ts — mock fetch, test error normalisation + SidecarApiError.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sidecarClient, SidecarApiError } from './sidecar-client.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'Error',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: new Headers(),
  } as Response);
}

// ── Mock tauriBridge ──────────────────────────────────────────────────────────
// The sidecar-client imports tauriBridge which uses dynamic import of @tauri-apps/api.
// In test environment, it should fall back to DEFAULT_PORT (3421).

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sidecarClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Default: healthy response
    mockFetch(200, { ok: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── baseUrl / port discovery ──────────────────────────────────────────────

  it('baseUrl() returns http://127.0.0.1:3421 in test mode (no Tauri)', async () => {
    const url = await sidecarClient.baseUrl();
    expect(url).toBe('http://127.0.0.1:3421');
  });

  it('streamUrl() appends lastEventId as query param', async () => {
    const url = await sidecarClient.streamUrl('/api/turns/t1/events', { lastEventId: 5 });
    expect(url).toContain('lastEventId=5');
    expect(url).toContain('/api/turns/t1/events');
  });

  // ── request<T> — happy path ───────────────────────────────────────────────

  it('request<T> returns parsed JSON on 200', async () => {
    mockFetch(200, { id: 'abc', name: 'Test' });

    const result = await sidecarClient.request<{ id: string; name: string }>('/api/sessions');
    expect(result).toEqual({ id: 'abc', name: 'Test' });
  });

  it('request with json auto-sets Content-Type and stringifies body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
      headers: new Headers(),
    } as Response);
    globalThis.fetch = fetchSpy;

    await sidecarClient.request('/api/turns', {
      method: 'POST',
      json: { mode: 'chat', userInput: 'hi' },
    });

    const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(callArgs[1].headers).toBeDefined();
    expect(callArgs[1].body).toBe(JSON.stringify({ mode: 'chat', userInput: 'hi' }));
  });

  // ── Error normalisation ───────────────────────────────────────────────────

  it('throws SidecarApiError on 4xx with JSON body', async () => {
    mockFetch(404, { error: 'card_not_found', code: 'CARD_404' });

    await expect(
      sidecarClient.request('/api/cards/ghost'),
    ).rejects.toThrow(SidecarApiError);

    try {
      await sidecarClient.request('/api/cards/ghost');
      expect.fail('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(SidecarApiError);
      const apiErr = err as SidecarApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.message).toBe('card_not_found');
      expect(apiErr.code).toBe('CARD_404');
    }
  });

  it('throws SidecarApiError on 500 with non-JSON body', async () => {
    mockFetch(500, '<html>Internal Server Error</html>');

    await expect(
      sidecarClient.request('/api/turns'),
    ).rejects.toThrow(SidecarApiError);

    try {
      await sidecarClient.request('/api/turns');
      expect.fail('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(SidecarApiError);
      const apiErr = err as SidecarApiError;
      expect(apiErr.status).toBe(500);
      // Body is truncated to 200 chars in error message
      expect(apiErr.message).toContain('Internal Server Error');
    }
  });

  it('throws with cause=sidecar_unreachable on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      sidecarClient.request('/api/health'),
    ).rejects.toMatchObject({
      message: expect.stringContaining('unreachable'),
    });
  });

  // ── 204 No Content ────────────────────────────────────────────────────────

  it('returns undefined for 204 No Content', async () => {
    mockFetch(204, '');

    const result = await sidecarClient.request('/api/sessions/s1', { method: 'DELETE' });
    expect(result).toBeUndefined();
  });

  // ── requestRaw ────────────────────────────────────────────────────────────

  it('requestRaw returns the Response object', async () => {
    mockFetch(200, { data: [1, 2, 3] });

    const res = await sidecarClient.requestRaw('/api/sessions');
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toEqual({ data: [1, 2, 3] });
  });
});
