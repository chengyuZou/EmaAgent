export { createTTSCall, createTTSVoiceRegistrar } from './textToSpeech.js';
export { isTTSError, TTSError } from './errors.js';
export type { TTSErrorCode } from './errors.js';
export type {
  CallTTS,
  PcmAudioFormat,
  TTSConnection,
  TTSProtocol,
  TTSRequest,
  TTSStreamEvent,
  TTSVoice,
  TTSVoiceReference,
  TTSProviderVoice,
  TTSVoiceRegistrar,
} from './types.js';
export { createPcmWavHeader, packPcmWav } from './audio/wav.js';
