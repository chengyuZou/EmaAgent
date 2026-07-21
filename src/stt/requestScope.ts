// 组合调用方取消与 STT 超时，并在结束后释放监听器和定时器。
import { SttError } from './errors.js';

export interface SttRequestScope {
  signal: AbortSignal;
  dispose(): void;
}

/** 合并上游取消与 STT 自身 deadline，并在请求结束后释放监听器和定时器。 */
export function createSttRequestScope(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): SttRequestScope {
  const controller = new AbortController();

  const abortFromUpstream = (): void => {
    controller.abort(new SttError('aborted', 'STT request was aborted'));
  };

  if (upstream?.aborted) abortFromUpstream();
  else upstream?.addEventListener('abort', abortFromUpstream, { once: true });

  const timer = setTimeout(() => {
    controller.abort(new SttError(
      'timeout',
      `STT request exceeded its ${timeoutMs}ms deadline`,
      { retryable: true },
    ));
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', abortFromUpstream);
    },
  };
}
