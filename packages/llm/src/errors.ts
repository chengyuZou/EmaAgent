/** Provider 因上下文超限拒绝请求。Agent 可据此触发响应式压缩。 */
export class ContextWindowExceededError extends Error {
  constructor(message?: string) {
    super(message ?? 'Context window exceeded');
    this.name = 'ContextWindowExceededError';
  }
}

/** Provider 熔断器处于 open 状态，本次调用未进入 Adapter。 */
export class CircuitOpenError extends Error {
  constructor(
    message: string,
    readonly opensAt: number,
  ) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/** Adapter 流违反统一 LLM 流协议。 */
export class LlmStreamProtocolError extends Error {
  readonly code = 'provider/incomplete_stream' as const;

  constructor(readonly providerId: string) {
    super(`LLM stream from provider "${providerId}" ended without a terminal done event`);
    this.name = 'LlmStreamProtocolError';
  }
}

/**
 * 识别用户/父任务取消。超时错误不属于取消，应继续计入 Provider 故障。
 * signal 已取消时优先信任调用链的显式取消事实，兼容 SDK 包装后的错误类型。
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;

  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError'
      || candidate.name === 'APIUserAbortError'
      || candidate.code === 'ABORT_ERR';
}

/** 抛出 AbortSignal 的原始 reason；没有 Error reason 时生成标准 AbortError。 */
export function throwAbortReason(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  if (signal.reason !== undefined) throw signal.reason;

  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  throw error;
}
