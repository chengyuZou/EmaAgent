import type { EmbedProtocol } from '@ema-agent/provider';
import type { UsageContext, UsageRecord, UsageRecorder } from '@ema-agent/usage';
import type { EmbeddingSpace } from './embeddingSpace.js';

export type { EmbedProtocol };

export interface EmbedProviderConfig {
  /** `provider_configs.id`，不是静态 Provider Definition ID。 */
  id: string;
  protocol: EmbedProtocol;
  apiKey: string;
  baseUrl?: string;
  /** Provider 能暴露固定模型版本时填写；缺省表示版本由 Provider 托管。 */
  embeddingRevision?: string;
}

export interface EmbedRequest {
  providerId: string;
  model: string;
  texts: string[];
  signal?: AbortSignal;
  usageContext?: UsageContext;
}

export interface EmbedResponse {
  embeddings: number[][];
  dim: number;
  space: EmbeddingSpace;
}

export interface RawEmbedResponse {
  embeddings: number[][];
  dim: number;
}

export interface EmbedProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface EmbedRuntimeOptions {
  usageRecorder?: UsageRecorder;
  onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
}

export interface EmbedAdapter {
  embed(texts: string[], model: string, signal?: AbortSignal): Promise<RawEmbedResponse>;
}
