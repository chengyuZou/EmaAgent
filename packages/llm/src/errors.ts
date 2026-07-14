import type { ErrorCode } from '@ema-agent/contracts';

interface ProviderErrorShape {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  providerCode?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  } | null;
}

/** Provider 因上下文超限拒绝请求。Agent 可据此触发响应式压缩。 */
export class ContextWindowExceededError extends Error {
  constructor(message?: string, cause?: unknown) {
    super(message ?? 'Context window exceeded');
    this.name = 'ContextWindowExceededError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Provider 通过流事件报告的显式失败，不依赖调用方解析 SDK 私有对象。 */
export class LlmProviderResponseError extends Error {
  readonly code = 'provider/response_failed' as const;

  constructor(
    message: string,
    readonly providerId: string,
    readonly providerCode: string | null,
    readonly status: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmProviderResponseError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Provider 返回了无法解析的工具参数；该调用不得进入 Permission 或 Sandbox。 */
export class LlmToolArgumentsParseError extends Error {
  readonly code = 'provider/tool_arguments_invalid_json' as const;
  readonly rawArgumentsExcerpt: string;

  constructor(
    readonly providerId: string,
    readonly callId: string,
    readonly toolName: string,
    rawArguments: string,
    cause?: unknown,
  ) {
    super(
      `Provider "${providerId}" returned invalid JSON arguments for tool `
      + `"${toolName}" (call "${callId}")`,
    );
    this.name = 'LlmToolArgumentsParseError';
    this.rawArgumentsExcerpt = rawArguments.slice(0, 500);
    if (cause !== undefined) this.cause = cause;
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

/** 将 SDK 抛出的上下文超限错误归一化，其余 Error 保留原始 status/code 供重试层判断。 */
export function normalizeLlmProviderError(error: unknown): Error {
  if (error instanceof ContextWindowExceededError) return error;

  if (isContextWindowExceeded(error)) {
    return new ContextWindowExceededError(errorMessage(error), error);
  }

  if (
    error instanceof LlmProviderResponseError
    || error instanceof LlmToolArgumentsParseError
    || error instanceof LlmStreamProtocolError
  ) {
    return error;
  }

  if (error instanceof Error) return error;
  return new Error(String(error));
}

/** 把 Responses API 的 error/failed 事件转换成带稳定字段的领域错误。 */
export function createLlmProviderResponseError(input: {
  providerId: string;
  message: string;
  providerCode?: string | null;
  cause?: unknown;
}): Error {
  const providerCode = input.providerCode ?? null;
  const error = new LlmProviderResponseError(
    input.message,
    input.providerId,
    providerCode,
    statusForProviderCode(providerCode),
    input.cause,
  );
  return normalizeLlmProviderError(error);
}

/** 编排层只消费稳定 ErrorCode，不需要了解各 SDK 或领域异常的内部字段。 */
export function llmProviderErrorCode(error: unknown): ErrorCode {
  if (error instanceof ContextWindowExceededError) {
    return 'provider/context_too_long';
  }
  if (error instanceof LlmToolArgumentsParseError) {
    return error.code;
  }
  return 'provider/server_error';
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

/** Adapter catch 的统一取消边界；命中后始终抛出，不允许伪装为 done。 */
export function throwIfAbortError(error: unknown, signal?: AbortSignal): void {
  if (!isAbortError(error, signal)) return;
  if (signal?.aborted) throwAbortReason(signal);
  if (error instanceof Error) throw error;

  const abortError = new Error(String(error));
  abortError.name = 'AbortError';
  throw abortError;
}

/** 防御 SDK 在收到 AbortSignal 后静默结束迭代而不抛错。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throwAbortReason(signal);
}

/** 抛出 AbortSignal 的原始 reason；没有 Error reason 时生成标准 AbortError。 */
export function throwAbortReason(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  if (signal.reason !== undefined) throw signal.reason;

  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  throw error;
}

function isContextWindowExceeded(error: unknown): boolean {
  const shape = error && typeof error === 'object'
    ? error as ProviderErrorShape
    : undefined;
  const status = numericStatus(shape?.status) || numericStatus(shape?.statusCode);
  const code = stringValue(shape?.providerCode)
    ?? stringValue(shape?.code)
    ?? stringValue(shape?.error?.code);
  const message = errorMessage(error).toLowerCase();

  if (code && (
    code.includes('context_length')
    || code.includes('context_window')
    || code === 'prompt_too_long'
  )) {
    return true;
  }

  if (status !== 400 && status !== 413) return false;
  return message.includes('maximum context length')
    || message.includes('context_length_exceeded')
    || message.includes('context window')
    || message.includes('prompt is too long')
    || message.includes('prompt_too_long');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const shape = error as ProviderErrorShape;
    const nestedMessage = stringValue(shape.error?.message);
    if (nestedMessage) return nestedMessage;
  }
  return String(error);
}

function statusForProviderCode(code: string | null): number {
  if (code === 'rate_limit_exceeded') return 429;
  if (code === 'server_error' || code === 'vector_store_timeout') return 503;
  if (
    code?.startsWith('invalid_')
    || code?.startsWith('unsupported_')
    || code === 'prompt_too_long'
    || code?.includes('context_length')
    || code?.includes('context_window')
  ) {
    return 400;
  }
  return 500;
}

function numericStatus(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.toLowerCase()
    : undefined;
}
