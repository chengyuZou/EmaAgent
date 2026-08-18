// 把协议输入错误、Provider 失败、取消和不完整流归一成稳定错误。
import type { LlmProtocol } from '@ema-agent/providers';

export type LlmErrorCode =
  | 'provider/context_too_long'
  | 'provider/input_unsupported'
  | 'provider/server_error'
  | 'provider/tool_arguments_invalid_json';

interface ProviderErrorShape {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  providerCode?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

/** 中立消息含有目标协议无法表达的内容，禁止协议实现静默丢弃。 */
export class LlmProtocolInputError extends Error {
  readonly code = 'provider/input_unsupported' as const;

  constructor(
    readonly protocol: LlmProtocol,
    readonly messageIndex: number,
    readonly blockIndex: number,
    readonly contentType: string,
    detail: string,
  ) {
    super(
      `${protocol} cannot encode ${contentType} at messages[${messageIndex}]`
      + `[${blockIndex}]: ${detail}`,
    );
    this.name = 'LlmProtocolInputError';
  }
}

/** Provider 因上下文超限拒绝请求；上层可据此执行一次响应式压缩。 */
export class ContextWindowExceededError extends Error {
  constructor(message = 'Context window exceeded', cause?: unknown) {
    super(message);
    this.name = 'ContextWindowExceededError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Provider 通过流终态显式报告失败。 */
export class LlmProviderResponseError extends Error {
  readonly code = 'provider/response_failed' as const;

  constructor(
    message: string,
    readonly protocol: LlmProtocol,
    readonly providerCode: string | null,
    readonly status: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmProviderResponseError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Provider 返回损坏的 Tool 参数；该调用不得进入 Permission 或 Sandbox。 */
export class LlmToolArgumentsParseError extends Error {
  readonly code = 'provider/tool_arguments_invalid_json' as const;
  readonly rawArgumentsExcerpt: string;

  constructor(
    readonly protocol: LlmProtocol,
    readonly callId: string,
    readonly toolName: string,
    rawArguments: string,
    cause?: unknown,
  ) {
    super(`${protocol} returned invalid JSON arguments for tool "${toolName}" (call "${callId}")`);
    this.name = 'LlmToolArgumentsParseError';
    this.rawArgumentsExcerpt = rawArguments.slice(0, 500);
    if (cause !== undefined) this.cause = cause;
  }
}

/** SDK 流没有给出协议规定的结束事件，不能把网络断流伪装成正常完成。 */
export class LlmStreamProtocolError extends Error {
  readonly code = 'provider/incomplete_stream' as const;

  constructor(readonly protocol: LlmProtocol) {
    super(`${protocol} stream ended without an explicit terminal event`);
    this.name = 'LlmStreamProtocolError';
  }
}

export function normalizeLlmProviderError(error: unknown): Error {
  if (error instanceof ContextWindowExceededError) return error;
  if (isContextWindowExceeded(error)) {
    return new ContextWindowExceededError(errorMessage(error), error);
  }
  if (
    error instanceof LlmProtocolInputError
    || error instanceof LlmProviderResponseError
    || error instanceof LlmToolArgumentsParseError
    || error instanceof LlmStreamProtocolError
  ) {
    return error;
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createLlmProviderResponseError(input: {
  protocol: LlmProtocol;
  message: string;
  providerCode?: string | null;
  cause?: unknown;
}): Error {
  const providerCode = input.providerCode ?? null;
  return normalizeLlmProviderError(new LlmProviderResponseError(
    input.message,
    input.protocol,
    providerCode,
    statusForProviderCode(providerCode),
    input.cause,
  ));
}

/** Turn 只消费稳定错误码，不解析任何 SDK 私有错误对象。 */
export function llmProviderErrorCode(error: unknown): LlmErrorCode {
  if (error instanceof ContextWindowExceededError) return 'provider/context_too_long';
  if (error instanceof LlmProtocolInputError) return error.code;
  if (error instanceof LlmToolArgumentsParseError) return error.code;
  return 'provider/server_error';
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError'
    || candidate.name === 'APIUserAbortError'
    || candidate.code === 'ABORT_ERR';
}

export function throwIfAbortError(error: unknown, signal?: AbortSignal): void {
  if (!isAbortError(error, signal)) return;
  if (signal?.aborted) throwAbortReason(signal);
  if (error instanceof Error) throw error;
  const abortError = new Error(String(error));
  abortError.name = 'AbortError';
  throw abortError;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throwAbortReason(signal);
}

function throwAbortReason(signal: AbortSignal): never {
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
  )) return true;

  if (status !== 400 && status !== 413) return false;
  return message.includes('maximum context length')
    || message.includes('context_length_exceeded')
    || message.includes('context window')
    || message.includes('prompt is too long')
    || message.includes('prompt_too_long')
    || message.includes('request payload size')
    || message.includes('exceeds the limit');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const nested = stringValue((error as ProviderErrorShape).error?.message);
    if (nested) return nested;
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
  ) return 400;
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
