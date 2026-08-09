export type SttErrorCode =
  | 'stt/invalid_request'
  | 'stt/http_error'
  | 'stt/invalid_response';

/** STT 对真实请求和外部响应的稳定错误。 */
export class SttError extends Error {
  readonly name = 'SttError';

  constructor(
    readonly code: SttErrorCode,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export function isSttError(error: unknown): error is SttError {
  return error instanceof SttError;
}
