// 定义 Narrative Bridge 请求的稳定错误分类和诊断字段。

// TODO: 需要加什么 health error吗还有别的各种字段
export type NarrativeClientErrorCode =
  | 'narrative/unavailable'
  | 'narrative/timeout'
  | 'narrative/http_error'
  | 'narrative/invalid_response';

export interface NarrativeClientErrorOptions {
  code: NarrativeClientErrorCode;
  retryable: boolean;
  status?: number;
  cause?: unknown;
}

export class NarrativeClientError extends Error {
  override readonly name: string = 'NarrativeClientError';
  readonly code: NarrativeClientErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: NarrativeClientErrorOptions) {
    super(message, { cause: options.cause });
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export class NarrativeUnavailableError extends NarrativeClientError {
  override readonly name = 'NarrativeUnavailableError';

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, {
      code: 'narrative/unavailable',
      retryable: true,
      ...options,
    });
  }
}

export class NarrativeRequestError extends NarrativeClientError {
  override readonly name = 'NarrativeRequestError';
}
