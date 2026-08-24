export type VisionErrorCode =
  | 'vision/invalid_request'
  | 'vision/unsupported_input'
  | 'vision/call_failed'
  | 'vision/invalid_response';

export class VisionError extends Error {
  readonly code: VisionErrorCode;
  readonly status?: number;

  constructor(code: VisionErrorCode, message: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'VisionError';
    this.code = code;
    this.status = status;
  }
}

export function isVisionError(error: unknown): error is VisionError {
  return error instanceof VisionError;
}
