// 组合调用方取消与 Vision 超时，并区分用户取消和运行时超时。
export interface VisionRequestScope {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

export function createVisionRequestScope(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): VisionRequestScope {
  const controller = new AbortController();
  let didTimeout = false;

  const onAbort = (): void => {
    controller.abort(upstream?.reason);
  };

  if (upstream?.aborted) controller.abort(upstream.reason);
  else upstream?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error('vision/timeout'));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', onAbort);
    },
  };
}
