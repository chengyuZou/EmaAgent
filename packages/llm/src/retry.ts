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
 * 用指数退避重试包裹一个 async factory。
 *
 * | HTTP 状态码        | 抛出的 error code              |
 * |--------------------|-------------------------------|
 * | 401 / 403          | auth/api_key_invalid           |
 * | 413                | provider/context_too_long      |
 * | 429                | provider/rate_limit(会重试)    |
 * | 408 / 5xx          | provider/timeout 或 /server_error(会重试) |
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

// ── 熔断器 ──────────────────────────────────────────────────────────
//
// per-provider 状态机:closed -> open -> half-open -> closed。
//
//   closed:     正常运行,累计连续 5xx 失败。
//   open:       窗口内 N 次连续失败 -> 阻断所有调用 cooldownMs。
//               快速失败返回 CircuitOpenError。
//   half-open:  冷却后允许一次 probe 调用。
//               成功 -> 重置为 closed;失败 -> 回到 open。

const CB_FAILURE_THRESHOLD = 3;       // 触发熔断的连续 5xx 次数
const CB_WINDOW_MS         = 60_000;  // 超过此时间重置失败计数
const CB_COOLDOWN_MS       = 30_000;  // open 持续时长

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

  /** 每次请求前调用。熔断器 open 时抛 CircuitOpenError。 */
  guard(now = Date.now()): void {
    switch (this.state.phase) {
      case 'closed': {
        // 过期旧的失败窗口。
        if (this.state.failures > 0 && now - this.state.firstFailureAt > CB_WINDOW_MS) {
          this.state = { phase: 'closed', failures: 0, firstFailureAt: 0 };
        }
        return; // 放行
      }
      case 'open': {
        if (now - this.state.since >= CB_COOLDOWN_MS) {
          this.state = { phase: 'half-open' };
          return; // 放行一次 probe
        }
        throw new CircuitOpenError(
          `LLM circuit breaker open - cooling down until ${new Date(this.state.since + CB_COOLDOWN_MS).toISOString()}`,
          this.state.since,
        );
      }
      case 'half-open': {
        return; // 放行 probe
      }
    }
  }

  /** 成功响应后调用。重置熔断器。 */
  success(): void {
    this.state = { phase: 'closed', failures: 0, firstFailureAt: 0 };
  }

  /** 失败后调用。递增失败计数;达到阈值则跳转 open。 */
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
        // probe 失败 - 回到 open。
        this.state = { phase: 'open', since: now };
        return;
      }
      case 'open': {
        // 已 open;无操作。
        return;
      }
    }
  }

  get phase(): CbState['phase'] {
    return this.state.phase;
  }
}
