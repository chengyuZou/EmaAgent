export type VisionErrorCode =
  | 'vision/invalid_request'
  | 'vision/unsupported_input'
  | 'vision/http_error'
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

/** SDK 网络错误在协议边界归一；调用方取消保持原始 AbortError。 */
export function throwVisionProtocolError(error: unknown): never {
  if (error instanceof VisionError || isAbortError(error)) throw error;
  const status = httpStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  throw new VisionError('vision/http_error', message, status, error);
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const status = candidate.status ?? candidate.statusCode;
  return typeof status === 'number' ? status : undefined;
}
