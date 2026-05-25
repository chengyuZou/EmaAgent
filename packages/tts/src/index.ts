// ── Public API ──────────────────────────────────────────────────────────────

export { TtsClient } from './service.js';

export { TtsCoordinator } from './coordinator.js';
export type { TtsCoordinatorArgs } from './coordinator.js';

export type {
  TtsAdapter,
  TtsProviderConfig,
  TtsRequest,
  TtsStreamEvent,
  TtsVoiceRef,
  TtsAudioFormat,
  TtsProtocol,
} from './types.js';

export { SentenceSplitter } from './streaming/sentence-splitter.js';
export type { SentenceChunk } from './streaming/sentence-splitter.js';
export { filterTextForTts } from './streaming/text-filter.js';

export { FsAudioArchive } from './archive.js';
export type { AudioArchive, SegmentWriter } from './archive.js';

export {
  ttsEventToEma, makeSentenceId, parseSentenceId,
} from './bridge.js';
export type { BridgeContext } from './bridge.js';

export { OpenAiTtsAdapter }    from './adapters/openai-tts.js';
export { GptSoVitsTtsAdapter } from './adapters/gpt-sovits-tts.js';
export { DashscopeTtsAdapter, dashscopeModelFamily } from './adapters/dashscope-tts.js';
