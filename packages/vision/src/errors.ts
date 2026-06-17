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

export interface VisionErrorMeta {
  providerId?: string;
  model?: string;
  task?: string;
  retryable?: boolean;
  status?: number;
  context?: unknown;
}

export class VisionError extends Error {
  readonly code: VisionErrorCode;
  readonly details?: unknown;
  readonly meta: VisionErrorMeta;

  constructor(
    code: VisionErrorCode,
    message: string,
    options: { cause?: unknown; details?: unknown; meta?: VisionErrorMeta } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VisionError';
    this.code = code;
    this.details = options.details;
    this.meta = options.meta ?? {};
  }
}

export function isVisionError(error: unknown): error is VisionError {
  return error instanceof VisionError;
}

export function classifyVisionError(
  error: unknown,
  meta: VisionErrorMeta = {},
  timedOut = false,
): VisionError {
  if (error instanceof VisionError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const status = httpStatus(error);
  const lower = message.toLowerCase();

  if (timedOut) {
    return new VisionError('vision/timeout', 'Vision request timed out', {
      cause: error,
      meta: { ...meta, retryable: true },
    });
  }

  if (isAbortError(error) || lower.includes('abort')) {
    return new VisionError('vision/aborted', 'Vision request was aborted', {
      cause: error,
      meta: { ...meta, retryable: false },
    });
  }

  if (lower.includes('provider/not_configured') || lower.includes('not_configured')) {
    return new VisionError('vision/not_configured', message, {
      cause: error,
      meta: { ...meta, status, retryable: false },
    });
  }

  if (status === 401 || status === 403 || lower.includes('auth/api_key_invalid')) {
    return new VisionError('vision/auth_failed', message, {
      cause: error,
      meta: { ...meta, status, retryable: false },
    });
  }

  if (status === 413 || lower.includes('provider/context_too_long') || lower.includes('context_too_long')) {
    return new VisionError('vision/context_too_large', message, {
      cause: error,
      meta: { ...meta, status, retryable: false },
    });
  }

  if (status === 429 || lower.includes('rate_limit') || lower.includes('too many requests')) {
    return new VisionError('vision/rate_limited', message, {
      cause: error,
      meta: { ...meta, status, retryable: true },
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
      meta: { ...meta, status, retryable: true },
    });
  }

  return new VisionError('vision/provider_failed', message, {
    cause: error,
    meta: { ...meta, status, retryable: false },
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const status = record['status'] ?? record['statusCode'];
  return typeof status === 'number' ? status : undefined;
}
