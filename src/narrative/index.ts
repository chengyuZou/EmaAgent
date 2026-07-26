// 导出 Narrative Client、错误类型和 Bridge 协议类型。
export { NarrativeClient } from './client.js';
export {
  NarrativeClientError,
  NarrativeRequestError,
  NarrativeUnavailableError,
} from './errors.js';
export type { NarrativeClientErrorCode, NarrativeClientErrorOptions } from './errors.js';

export type {
  BridgeConfigurePayload,
  BridgeEmbedCfg,
  BridgeLlmCfg,
  BridgeCapabilities,
  BridgeHealthResponse,
  NarrativeRouteRequest,
  NarrativeRouteResponse,
  NarrativeQueryRequest,
  NarrativeQueryResponse,
} from './types.js';
export type { NarrativeEvent, NarrativeTimelineFailureCode } from './events.js';
export { prepareNarrativeRecall } from './recall.js';
export type {
  NarrativeRecallResult,
  NarrativeRecallTimeline,
  NarrativeSearchPort,
  PrepareNarrativeRecallInput,
} from './recall.js';
