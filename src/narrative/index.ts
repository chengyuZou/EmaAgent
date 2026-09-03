// 导出 Narrative Client、错误类型、设置定义和 Bridge 协议类型。
export { NarrativeClient } from './client.js';
export {
  NarrativeClientError,
  NarrativeRequestError,
  NarrativeUnavailableError,
} from './errors.js';
export type { NarrativeClientErrorCode, NarrativeClientErrorOptions } from './errors.js';

export type {
  NarrativeBridgeConfigureRequest,
  NarrativeEmbeddingConnection,
  NarrativeLlmConnection,
  NarrativeQueryMode,
  NarrativeRecallRequest,
  NarrativeRecallResponse,
  NarrativeTimelineFailure,
  NarrativeTimelineFailureCode,
} from './types.js';
export type {
  NarrativeEvent,
  NarrativeRecallFailureCode,
  NarrativeTimelineSummary,
} from './events.js';
export { prepareNarrativeRecall } from './recall.js';
export type {
  NarrativeRecallResult,
  NarrativeRecallTimeline,
  NarrativeSearch,
  PrepareNarrativeRecallInput,
} from './recall.js';
export { narrativeQueryModeSetting } from './settings.js';
