// ── Public API ──────────────────────────────────────────────────────────────

export { TtsRuntime } from './ttsRuntime.js';
export type { TtsRuntimeOptions } from './ttsRuntime.js';

export { TtsCoordinator } from './coordinator.js';
export type { TtsCoordinatorArgs } from './coordinator.js';

export type {
  TtsAdapter,
  TtsProviderConfig,
  TtsRequest,
  TtsStreamEvent,
  TtsVoiceRef,
  TtsAudioFormat,
  TtsErrorCode,
  TtsProtocol,
  TtsHealthResult,
  TtsProviderHealth,
  TtsProbeResult,
  TtsLimits,
  TtsAudioDelivery,
  TtsAdapterCapabilities,
} from './types.js';

export { SentenceSplitter } from './streaming/sentenceSplitter.js';
export type { SentenceChunk } from './streaming/sentenceSplitter.js';
export { TextFilterStream, filterSentenceForTts } from './streaming/textFilter.js';

export { FsAudioArchive } from './archive.js';
export type { AudioArchive, SegmentWriter, FinalizedAudio } from './archive.js';

export {
  ttsEventToEma, makeSentenceId, parseSentenceId,
} from './bridge.js';
export type { BridgeContext } from './bridge.js';
export type { LipSyncFrame, TtsEvent } from './events.js';
