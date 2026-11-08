export class SpeechRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SpeechRequestError';
  }
}

export type SpeechVoicePreviewErrorCode =
  | 'client_unavailable'
  | 'no_reference_audio'
  | 'synthesis_failed';

export class SpeechVoicePreviewError extends Error {
  constructor(
    readonly code: SpeechVoicePreviewErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SpeechVoicePreviewError';
  }
}

export interface SpeechGenerationFailure {
  readonly code: string;
  readonly message: string;
}
