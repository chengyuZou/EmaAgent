export type RerankErrorCode =
  | 'rerank/invalid_request'
  | 'rerank/http_error'
  | 'rerank/invalid_response';

/** Rerank 对真实请求和外部响应的稳定错误。 */
export class RerankError extends Error {
  readonly name = 'RerankError';

  constructor(
    readonly code: RerankErrorCode,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
