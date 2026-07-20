import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../retry.js';

// Speed-up helper — overrides sleep to be instant
const FAST: import('../retry.js').RetryOptions = { maxAttempts: 3, baseDelayMs: 0 };

function httpErr(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('withRetry — success path', () => {
  it('returns on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await withRetry(fn, FAST)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and returns on second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(httpErr(429))
      .mockResolvedValue('recovered');
    expect(await withRetry(fn, FAST)).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 and returns on third attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(httpErr(500))
      .mockRejectedValueOnce(httpErr(503))
      .mockResolvedValue('ok');
    expect(await withRetry(fn, FAST)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on 408 (timeout)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(httpErr(408))
      .mockResolvedValue('ok');
    expect(await withRetry(fn, FAST)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetry — immediate-throw codes', () => {
  it('throws ErrorCode message for 401', async () => {
    const fn = vi.fn().mockRejectedValue(httpErr(401));
    await expect(withRetry(fn, FAST)).rejects.toThrow('auth/api_key_invalid');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws ErrorCode message for 403', async () => {
    const fn = vi.fn().mockRejectedValue(httpErr(403));
    await expect(withRetry(fn, FAST)).rejects.toThrow('auth/api_key_invalid');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws ErrorCode message for 413', async () => {
    const fn = vi.fn().mockRejectedValue(httpErr(413));
    await expect(withRetry(fn, FAST)).rejects.toThrow('provider/context_too_long');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('preserves original error as cause on 401', async () => {
    const original = httpErr(401);
    const fn = vi.fn().mockRejectedValue(original);
    const thrown = await withRetry(fn, FAST).catch(e => e as Error);
    expect((thrown as Error & { cause: unknown }).cause).toBe(original);
  });
});

describe('withRetry — non-retryable errors', () => {
  it('rethrows non-HTTP errors immediately', async () => {
    const err = new Error('parse error');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, FAST)).rejects.toThrow('parse error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows 404 immediately', async () => {
    const fn = vi.fn().mockRejectedValue(httpErr(404));
    await expect(withRetry(fn, FAST)).rejects.toThrow('HTTP 404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows 400 immediately', async () => {
    const fn = vi.fn().mockRejectedValue(httpErr(400));
    await expect(withRetry(fn, FAST)).rejects.toThrow('HTTP 400');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry — maxAttempts exhausted', () => {
  it('stops after maxAttempts and rethrows original', async () => {
    const err = httpErr(429);
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 0 })).rejects.toThrow('HTTP 429');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects maxAttempts: 1 (no retry)', async () => {
    const fn = vi.fn().mockRejectedValue(httpErr(500));
    await expect(withRetry(fn, { maxAttempts: 1, baseDelayMs: 0 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
