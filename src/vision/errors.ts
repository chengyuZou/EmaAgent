import type { VisionInvocationContext, VisionSourceRef, VisionTask } from './types.js';

export type VisionErrorCode =
  | 'vision/not_configured'
  | 'vision/invalid_request'
  | 'vision/unsupported_input'
  | 'vision/payload_too_large'
  | 'vision/concurrency_limited'
  | 'vision/timeout'
  | 'vision/aborted'
  | 'vision/auth_failed'
  | 'vision/rate_limited'
  | 'vision/provider_unavailable'
  | 'vision/context_too_large'
  | 'vision/output_parse_failed'
  | 'vision/provider_failed';

export interface VisionErrorContext {
  providerId?: string;
  model?: string;
  task?: VisionTask;
  retryable?: boolean;
  status?: number;
  invocationContext?: VisionInvocationContext;
}

export interface VisionErrorDetails {
  maxQueued?: number;
  imageCount?: number;
  maxImages?: number;
  imageBytes?: number;
  maxBytesPerImage?: number;
  source?: VisionSourceRef;
  totalBytes?: number;
  maxTotalBytes?: number;
  rawTextExcerpt?: string;
}

export interface VisionErrorOptions extends VisionErrorContext {
  cause?: unknown;
  details?: VisionErrorDetails;
}

export class VisionError extends Error {
  readonly code: VisionErrorCode;
  readonly details?: VisionErrorDetails;
  readonly providerId?: string;
  readonly model?: string;
  readonly task?: VisionTask;
  readonly retryable: boolean;
  readonly status?: number;
  readonly invocationContext?: VisionInvocationContext;

  constructor(code: VisionErrorCode, message: string, options: VisionErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VisionError';
    this.code = code;
    this.details = options.details;
    this.providerId = options.providerId;
    this.model = options.model;
    this.task = options.task;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.invocationContext = options.invocationContext;
  }
}

export function isVisionError(error: unknown): error is VisionError {
  return error instanceof VisionError;
}

export function classifyVisionError(
  error: unknown,
  context: VisionErrorContext = {},
  timedOut = false,
): VisionError {
  if (error instanceof VisionError) {
    return new VisionError(error.code, error.message, {
      cause: error.cause,
      details: error.details,
      providerId: error.providerId ?? context.providerId,
      model: error.model ?? context.model,
      task: error.task ?? context.task,
      retryable: error.retryable,
      status: error.status ?? context.status,
      invocationContext: error.invocationContext ?? context.invocationContext,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const status = httpStatus(error);
  const lower = message.toLowerCase();

  if (timedOut) {
    return new VisionError('vision/timeout', 'Vision request timed out', {
      cause: error,
      ...context,
      retryable: true,
    });
  }

  if (isAbortError(error) || lower.includes('abort')) {
    return new VisionError('vision/aborted', 'Vision request was aborted', {
      cause: error,
      ...context,
      retryable: false,
    });
  }

  if (lower.includes('provider/not_configured') || lower.includes('not_configured')) {
    return new VisionError('vision/not_configured', message, {
      cause: error,
      ...context,
      status,
      retryable: false,
    });
  }

  if (status === 401 || status === 403 || lower.includes('auth/api_key_invalid')) {
    return new VisionError('vision/auth_failed', message, {
      cause: error,
      ...context,
      status,
      retryable: false,
    });
  }

  if (status === 413 || lower.includes('provider/context_too_long') || lower.includes('context_too_long')) {
    return new VisionError('vision/context_too_large', message, {
      cause: error,
      ...context,
      status,
      retryable: false,
    });
  }

  if (status === 429 || lower.includes('rate_limit') || lower.includes('too many requests')) {
    return new VisionError('vision/rate_limited', message, {
      cause: error,
      ...context,
      status,
      retryable: true,
    });
  }

  if (
    status === 408
    || (status !== undefined && status >= 500)
    || lower.includes('timeout')
    || lower.includes('econnreset')
    || lower.includes('enotfound')
    || lower.includes('network')
    || lower.includes('fetch failed')
  ) {
    return new VisionError('vision/provider_unavailable', message, {
      cause: error,
      ...context,
      status,
      retryable: true,
    });
  }

  return new VisionError('vision/provider_failed', message, {
    cause: error,
    ...context,
    status,
    retryable: false,
  });
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  const status = record.status ?? record.statusCode;
  return typeof status === 'number' ? status : undefined;
}
