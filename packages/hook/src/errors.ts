/** Hook 执行失败的稳定分类，供 trace 和诊断层使用。 */
export type HookFailureKind = 'handler_error' | 'timeout' | 'cancelled';

/** Hook 配置不合法，例如超时或并发数越界。 */
export class HookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookConfigurationError';
  }
}

/** 单个 Hook handler 超过允许的执行时间。 */
export class HookTimeoutError extends Error {
  readonly failureKind = 'timeout' as const;

  constructor(
    readonly handlerName: string,
    readonly timeoutMs: number,
  ) {
    super(`Hook handler "${handlerName}" timed out after ${timeoutMs}ms`);
    this.name = 'HookTimeoutError';
  }
}

/** Turn 等父任务取消后，Hook 执行链随之终止。 */
export class HookCancelledError extends Error {
  readonly failureKind = 'cancelled' as const;

  constructor(message: string) {
    super(message);
    this.name = 'HookCancelledError';
  }
}

/** 将未知异常归一化为诊断层使用的稳定失败类型。 */
export function classifyHookFailure(error: unknown): HookFailureKind {
  if (error instanceof HookTimeoutError) return error.failureKind;
  if (error instanceof HookCancelledError) return error.failureKind;
  return 'handler_error';
}
