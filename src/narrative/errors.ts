// 取消必须向调用方抛出, 不能记录成某个周目的检索失败.
// 调用方 signal 尚未标记取消时, 供应商抛出的 AbortError 也按取消处理.
export function throwIfCancelled(error: unknown, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (error instanceof Error && error.name === 'AbortError') {
    throw error;
  }
}
