export type EmbeddingErrorCode =
  | 'embed/invalid_request'
  | 'embed/http_error'
  | 'embed/invalid_response';

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
