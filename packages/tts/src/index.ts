// ── Public API ──────────────────────────────────────────────────────────────

export { TtsClient } from './service.js';
export type {
  TtsClientArgs,
  VoiceProfileLookup,
  VoiceRefPathResolver,
} from './service.js';

export type {
  TtsAdapter,
  TtsAdapterCall,
  TtsProviderConfig,
  TtsModuleBinding,
  TtsResolution,
  TtsRequest,
  TtsStreamEvent,
  TtsVoiceRef,
  TtsAudioFormat,
  TtsProtocol,
} from './types.js';

export {
  TTS_PROTOCOL_VOICE_SUPPORT,
  protocolSupportsVoiceKind,
} from './types.js';

export { SentenceSplitter } from './streaming/sentence-splitter.js';
export type { SentenceChunk } from './streaming/sentence-splitter.js';
export { filterTextForTts } from './streaming/text-filter.js';

export { FsAudioArchive } from './archive.js';
export type { AudioArchive, SegmentWriter } from './archive.js';

export { OpenAiTtsAdapter }    from './adapters/openai-tts.js';
export { GptSoVitsTtsAdapter } from './adapters/gpt-sovits-tts.js';
export { DashscopeTtsAdapter, dashscopeModelFamily } from './adapters/dashscope-tts.js';
