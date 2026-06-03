import type { ErrorCode } from '@ema-agent/contracts';

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export function httpStatus(e: unknown): number {
  return (e as { status?: number; statusCode?: number })?.status
      ?? (e as { status?: number; statusCode?: number })?.statusCode
      ?? 0;
}

export function isRetryable(e: unknown): boolean {
  const s = httpStatus(e);
  return s === 429 || s === 408 || (s >= 500 && s < 600);
}

export function rethrowAs(code: ErrorCode, cause: unknown): never {
  const err = new Error(code);
  err.cause = cause;
  throw err;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

const DEFAULT_OPTS: RetryOptions = { maxAttempts: 3, baseDelayMs: 1_000 };

/**
 * Wrap an async factory with exponential-backoff retry.
 *
 * | HTTP status        | Thrown error code              |
 * |--------------------|-------------------------------|
 * | 401 / 403          | auth/api_key_invalid           |
 * | 413                | provider/context_too_long      |
 * | 429                | provider/rate_limit  (retried) |
 * | 408 / 5xx          | provider/timeout or /server_error (retried) |
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_OPTS,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const s = httpStatus(e);
      if (s === 401 || s === 403) rethrowAs('auth/api_key_invalid',      e);
      if (s === 413)              rethrowAs('provider/context_too_long',  e);
      if (!isRetryable(e) || attempt === opts.maxAttempts - 1) throw e;
      await sleep(opts.baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}
