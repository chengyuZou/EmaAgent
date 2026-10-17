export type STTErrorCode =
  | 'stt/invalid_request'
  | 'stt/http_error'
  | 'stt/invalid_response';

export class STTError extends Error {
  readonly name = 'STTError';

  constructor(
    readonly code: STTErrorCode,
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export function isSTTError(error: unknown): error is STTError {
  return error instanceof STTError;
}
