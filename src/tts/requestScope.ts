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
  if (signal.aborted) throw new Error(String(signal.reason ?? 'aborted'));
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = (): void => reject(new Error(String(signal.reason ?? 'aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
