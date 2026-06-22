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

// ── Circuit breaker ──────────────────────────────────────────────────────────
//
// Per-provider state machine: closed → open → half-open → closed.
//
//   closed:     normal operation, counting consecutive 5xx failures.
//   open:       N consecutive failures within the window → block ALL calls
//               for cooldownMs. Returns a fast-fail CircuitOpenError.
//   half-open:  after cooldown, allow ONE probe call.
//               success → reset to closed; failure → back to open.

const CB_FAILURE_THRESHOLD = 3;       // consecutive 5xx to trip
const CB_WINDOW_MS         = 60_000;  // reset failure count after this
const CB_COOLDOWN_MS       = 30_000;  // stay open for this long

export class CircuitOpenError extends Error {
  constructor(
    message: string,
    readonly opensAt: number,
  ) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

type CbState =
  | { phase: 'closed'; failures: number; firstFailureAt: number }
  | { phase: 'open';   since: number }
  | { phase: 'half-open' };

export class CircuitBreaker {
  private state: CbState = { phase: 'closed', failures: 0, firstFailureAt: 0 };

  /** Call before every request. Throws CircuitOpenError when the breaker is open. */
  guard(now = Date.now()): void {
    switch (this.state.phase) {
      case 'closed': {
        // Expire old failure window.
        if (this.state.failures > 0 && now - this.state.firstFailureAt > CB_WINDOW_MS) {
          this.state = { phase: 'closed', failures: 0, firstFailureAt: 0 };
        }
        return; // allow
      }
      case 'open': {
        if (now - this.state.since >= CB_COOLDOWN_MS) {
          this.state = { phase: 'half-open' };
          return; // allow one probe
        }
        throw new CircuitOpenError(
          `LLM circuit breaker open — cooling down until ${new Date(this.state.since + CB_COOLDOWN_MS).toISOString()}`,
          this.state.since,
        );
      }
      case 'half-open': {
        return; // allow probe
      }
    }
  }

  /** Call after a successful response. Resets the breaker. */
  success(): void {
    this.state = { phase: 'closed', failures: 0, firstFailureAt: 0 };
  }

  /** Call after a failure. Increments the failure counter; trips to open if threshold reached. */
  failure(now = Date.now()): void {
    switch (this.state.phase) {
      case 'closed': {
        const failures = this.state.failures + 1;
        const firstFailureAt = this.state.failures === 0 ? now : this.state.firstFailureAt;
        if (failures >= CB_FAILURE_THRESHOLD) {
          this.state = { phase: 'open', since: now };
          return;
        }
        this.state = { phase: 'closed', failures, firstFailureAt };
        return;
      }
      case 'half-open': {
        // Probe failed — back to open.
        this.state = { phase: 'open', since: now };
        return;
      }
      case 'open': {
        // Already open; no-op.
        return;
      }
    }
  }

  get phase(): CbState['phase'] {
    return this.state.phase;
  }
}
