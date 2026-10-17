export type TTSErrorCode =
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

export class TTSError extends Error {
  constructor(
    readonly code: TTSErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TTSError';
  }
}

export function isTTSError(error: unknown): error is TTSError {
  return error instanceof TTSError;
}

export function ttsErrorFromHttp(status: number, message: string): TTSError {
  if (status === 401 || status === 403) {
    return new TTSError('tts/credentials', message);
  }
  if (status === 404) {
    return new TTSError('tts/unsupported_model', message);
  }
  if (status === 413) {
    return new TTSError('tts/resource_exhausted', message);
  }
  if (status === 400 || status === 422) {
    return new TTSError('tts/invalid_request', message);
  }
  return new TTSError('tts/provider_error', message);
}

export function ttsErrorFromNetwork(error: unknown, signal?: AbortSignal): TTSError {
  if (signal?.aborted || (error as { name?: string }).name === 'AbortError') {
    return new TTSError('tts/aborted', 'TTS request was aborted', error);
  }
  return new TTSError(
    'tts/network',
    error instanceof Error ? error.message : 'TTS network request failed',
    error,
  );
}
