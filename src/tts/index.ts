export { createTtsCall, createTtsVoiceRegistrar } from './textToSpeech.js';
export { isTtsError, TtsError } from './errors.js';
export type { TtsErrorCode } from './errors.js';
export type {
  CallTts,
  PcmAudioFormat,
  TtsConnection,
  TtsProtocol,
  TtsRequest,
  TtsStreamEvent,
  TtsVoice,
  TtsVoiceReference,
  TtsProviderVoice,
  TtsVoiceRegistrar,
} from './types.js';
export { packPcmWav } from './audio/wav.js';
