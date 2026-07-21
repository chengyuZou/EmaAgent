export type SttErrorCode =
  | 'not_configured'
  | 'invalid_request'
  | 'payload_too_large'
  | 'aborted'
  | 'timeout'
  | 'provider_failed'
  | 'invalid_response';

export interface SttErrorOptions {
  cause?: unknown;
  retryable?: boolean;
  status?: number;
  providerId?: string;
  model?: string;
}

/** STT Facade 对外暴露的稳定错误，调用方不需要解析供应商错误字符串。 */
export class SttError extends Error {
  readonly name = 'SttError';
  readonly retryable: boolean;
  readonly status?: number;
  readonly providerId?: string;
  readonly model?: string;

  constructor(
    readonly code: SttErrorCode,
    message: string,
    options: SttErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.providerId = options.providerId;
    this.model = options.model;
  }
}

export function isSttError(error: unknown): error is SttError {
  return error instanceof SttError;
}
