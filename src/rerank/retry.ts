// 非流式一次性请求的有限重试：只补一枪，退避可被取消；包内专用，不导出。
const RETRY_DELAY_MS = 500;

/**
 * 首试失败且故障可恢复时，退避后补一次。
 * 取消（含退避期间）立即抛出，不重试也不等待；客户端自身的 15s 超时同样不重试——
 * Provider 15 秒答不上来，再等 15 秒极少有意义，不如快速降级。
 */
export async function withOneRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  delayMs = RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (signal?.aborted || !isRetryableFailure(error)) throw error;
    await sleepAbortable(delayMs, signal);
    return fn();
  }
}

function isRetryableFailure(error: unknown): boolean {
  // fetch 网络层错误（DNS/连接拒绝/重置）没有 HTTP 状态
  if (error instanceof TypeError) return true;
  const status = (error as { status?: unknown } | null)?.status;
  return status === 429 || status === 408
    || (typeof status === 'number' && status >= 500 && status < 600);
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as unknown);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as unknown);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
