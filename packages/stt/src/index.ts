export { SttClient } from './service.js';
export type { SttAdapter, SttAdapterCall, SttProviderConfig, SttRequest, SttResponse, SttSegment, SttProtocol, SttHealthResult, SttProviderHealth, SttProbeResult, SttLimits } from './types.js';
export { SttError, isSttError } from './errors.js';
export type { SttErrorCode, SttErrorOptions } from './errors.js';
export { OpenAiSttAdapter } from './adapters/openai-stt.js';
