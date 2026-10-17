import type { LLMProtocol } from '@ema-agent/providers';

export type LLMErrorCode =
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

/** 输入内容无法转换为目标协议时报告具体位置, 不静默丢弃该内容. */
export class LLMProtocolInputError extends Error {
  readonly code = 'provider/input_unsupported' as const;

  constructor(
    readonly protocol: LLMProtocol,
    readonly messageIndex: number,
    readonly blockIndex: number,
    readonly contentType: string,
    detail: string,
  ) {
    super(
      `${protocol} cannot encode ${contentType} at messages[${messageIndex}]`
      + `[${blockIndex}]: ${detail}`,
    );
    this.name = 'LLMProtocolInputError';
  }
}

/** 供应商报告上下文过长, Agent 可据此压缩后重试. */
export class ContextWindowExceededError extends Error {
  constructor(message = 'Context window exceeded', cause?: unknown) {
    super(message);
    this.name = 'ContextWindowExceededError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** 供应商在响应或事件流中明确报告失败. */
export class LLMProviderResponseError extends Error {
  readonly code = 'provider/response_failed' as const;

  constructor(
    message: string,
    readonly protocol: LLMProtocol,
    readonly providerCode: string | null,
    readonly status: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'LLMProviderResponseError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** 工具参数无法解析为 JSON, 不交给后续权限检查和工具执行. */
export class LLMToolArgumentsParseError extends Error {
  readonly code = 'provider/tool_arguments_invalid_json' as const;

  constructor(
    readonly protocol: LLMProtocol,
    readonly callId: string,
    readonly toolName: string,
    cause?: unknown,
  ) {
    super(`${protocol} returned invalid JSON arguments for tool "${toolName}" (call "${callId}")`);
    this.name = 'LLMToolArgumentsParseError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** 没有收到协议结束事件就断流, 不能当作请求成功. */
export class LLMStreamProtocolError extends Error {
  readonly code = 'provider/incomplete_stream' as const;

  constructor(readonly protocol: LLMProtocol) {
    super(`${protocol} stream ended without an explicit terminal event`);
    this.name = 'LLMStreamProtocolError';
  }
}

export function normalizeLLMProviderError(error: unknown): Error {
  if (error instanceof ContextWindowExceededError) return error;
  if (isContextWindowExceeded(error)) {
    return new ContextWindowExceededError(errorMessage(error), error);
  }
  if (
    error instanceof LLMProtocolInputError
    || error instanceof LLMProviderResponseError
    || error instanceof LLMToolArgumentsParseError
    || error instanceof LLMStreamProtocolError
  ) {
    return error;
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createLLMProviderResponseError(input: {
  protocol: LLMProtocol;
  message: string;
  providerCode?: string | null;
  cause?: unknown;
}): Error {
  const providerCode = input.providerCode ?? null;
  return normalizeLLMProviderError(new LLMProviderResponseError(
    input.message,
    input.protocol,
    providerCode,
    statusForProviderCode(providerCode),
    input.cause,
  ));
}

/** Turn 和用量记录通过此处取得业务错误码, 不各自解析 SDK 错误. */
export function llmProviderErrorCode(error: unknown): LLMErrorCode {
  if (error instanceof ContextWindowExceededError) return 'provider/context_too_long';
  if (error instanceof LLMProtocolInputError) return error.code;
  if (error instanceof LLMToolArgumentsParseError) return error.code;
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
