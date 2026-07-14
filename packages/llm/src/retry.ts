import type { ErrorCode } from '@ema-agent/contracts';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function httpStatus(error: unknown): number {
  return (error as { status?: number; statusCode?: number })?.status
      ?? (error as { status?: number; statusCode?: number })?.statusCode
      ?? 0;
}

export function isRetryable(error: unknown): boolean {
  const status = httpStatus(error);
  return status === 429
      || status === 408
      || (status >= 500 && status < 600);
}

export function rethrowAs(code: ErrorCode, cause: unknown): never {
  const error = new Error(code);
  error.cause = cause;
  throw error;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
};

/**
 * 为非流式异步操作提供指数退避重试。
 *
 * 流式 LLM 请求不能使用该函数：一旦向上游交付 chunk，重试会造成文本或
 * 工具调用重复。流式生命周期由 LlmStreamRuntime 单独管理。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = DEFAULT_OPTIONS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = httpStatus(error);

      if (status === 401 || status === 403) {
        rethrowAs('auth/api_key_invalid', error);
      }
      if (status === 413) {
        rethrowAs('provider/context_too_long', error);
      }
      if (!isRetryable(error) || attempt === options.maxAttempts - 1) {
        throw error;
      }

      await sleep(options.baseDelayMs * 2 ** attempt);
    }
  }

  throw lastError;
}
