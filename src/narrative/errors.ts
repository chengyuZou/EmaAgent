/** 取消向调用方抛出, 包括 signal 尚未取消但供应商已抛出 AbortError 的情况. */
export function throwIfCancelled(error: unknown, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (error instanceof Error && error.name === 'AbortError') {
    throw error;
  }
}
