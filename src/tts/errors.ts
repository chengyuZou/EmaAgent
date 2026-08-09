export type TtsErrorCode =
  | 'tts/invalid_request'
  | 'tts/invalid_response'
  | 'tts/unsupported_model'
  | 'tts/unsupported_voice'
  | 'tts/credentials'
  | 'tts/reference_audio_missing'
  | 'tts/network'
  | 'tts/provider_error'
  | 'tts/aborted'
  | 'tts/resource_exhausted';

/** 对外只暴露稳定错误码，不把各协议的响应形状泄漏给调用方。 */
export class TtsError extends Error {
  constructor(
    readonly code: TtsErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TtsError';
  }
}

export function isTtsError(error: unknown): error is TtsError {
  return error instanceof TtsError;
}

export function ttsErrorFromHttp(status: number, message: string): TtsError {
  if (status === 401 || status === 403) return new TtsError('tts/credentials', message);
  if (status === 404) return new TtsError('tts/unsupported_model', message);
  if (status === 413) return new TtsError('tts/resource_exhausted', message);
  if (status === 400 || status === 422) return new TtsError('tts/invalid_request', message);
  return new TtsError('tts/provider_error', message);
}

export function ttsErrorFromNetwork(error: unknown, signal?: AbortSignal): TtsError {
  if (signal?.aborted || (error as { name?: string }).name === 'AbortError') {
    return new TtsError('tts/aborted', 'TTS request was aborted', error);
  }
  return new TtsError(
    'tts/network',
    error instanceof Error ? error.message : 'TTS network request failed',
    error,
  );
}
