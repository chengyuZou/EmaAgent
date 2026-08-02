import type { RerankProtocol } from '@ema-agent/provider';
import type { UsageContext, UsageRecord, UsageRecorder } from '@ema-agent/usage';

export type { RerankProtocol };

export interface RerankProviderConfig {
  /** `provider_configs.id`，不是静态 Provider Definition ID。 */
  id: string;
  protocol: RerankProtocol;
  apiKey: string;
  baseUrl?: string;
}

export interface RerankRequest {
  providerId: string;
  model: string;
  query: string;
  documents: string[];
  topK?: number;
  signal?: AbortSignal;
  usageContext?: UsageContext;
}

export interface RerankItem {
  index: number;
  score: number;
}

export interface RerankResponse {
  results: RerankItem[];
}

export interface RerankProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface RerankRuntimeOptions {
  usageRecorder: UsageRecorder;
  onUsageRecordError?: (error: unknown, record: UsageRecord) => void;
}

export interface RerankAdapter {
  rerank(
    query: string,
    documents: string[],
    topK: number,
    model: string,
    signal?: AbortSignal,
  ): Promise<RerankResponse>;
}
