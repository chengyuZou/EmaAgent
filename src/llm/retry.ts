// 流式运行时的错误分类与退避助手；重试循环本体在 streamRuntime（只能在首个 chunk 前重试）。
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
