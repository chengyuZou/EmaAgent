// 组合调用方取消与 TTS 超时，并让流读取能够立即响应取消。
export type TtsAbortReason = 'timeout' | 'aborted' | 'resource_exhausted';

export interface TtsRequestScope {
  signal: AbortSignal;
  abort(reason: TtsAbortReason): void;
  reason(): TtsAbortReason | undefined;
  dispose(): void;
}

export function createTtsRequestScope(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): TtsRequestScope {
  const controller = new AbortController();
  let abortReason: TtsAbortReason | undefined;
  const abort = (reason: TtsAbortReason): void => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort(reason);
  };
  const onUpstreamAbort = (): void => abort('aborted');
  if (upstream?.aborted) onUpstreamAbort();
  else upstream?.addEventListener('abort', onUpstreamAbort, { once: true });
  const timer = setTimeout(() => abort('timeout'), timeoutMs);
  return {
    signal: controller.signal,
    abort,
    reason: () => abortReason,
    dispose(): void {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', onUpstreamAbort);
    },
  };
}

export async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw abortReasonError(signal);
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = (): void => reject(abortReasonError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * 原样传递取消原因：Error reason 不包装；scope 的领域原因字符串（'aborted'/
 * 'timeout' 等）放进标准 AbortError 的 message，保真且能被 isAbortError 类
 * 检查正确识别为取消而非 Provider 故障。
 */
function abortReasonError(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    signal.reason !== undefined ? String(signal.reason) : 'The operation was aborted',
  );
  error.name = 'AbortError';
  return error;
}
