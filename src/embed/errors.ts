export type EmbeddingErrorCode =
  | 'embed/invalid_request'
  | 'embed/http_error'
  | 'embed/invalid_response';

/** Embedding 对真实请求和外部响应的稳定错误。 */
export class EmbeddingError extends Error {
  readonly name = 'EmbeddingError';

  constructor(
    readonly code: EmbeddingErrorCode,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
