import type { UsageContext } from '@ema-agent/usage';
import type { EmbedProtocol, RerankProtocol } from '@ema-agent/provider';
import type { EmbeddingSpace } from './embedding-space.js';

export type { EmbedProtocol, RerankProtocol };

// ── Provider configs ──────────────────────────────────────────────────────────

export interface EmbedProviderConfig {
  /** provider_configs.id UUID — router key. */
  id: string;
  protocol: EmbedProtocol;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  /** Provider 能暴露固定模型版本时填写；缺省表示版本由 Provider 托管。 */
  embeddingRevision?: string;
}

export interface RerankProviderConfig {
  id: string;
  protocol: RerankProtocol;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

// ── Requests / Responses ──────────────────────────────────────────────────────

export interface EmbedRequest {
  providerId: string;
  model: string;
  texts: string[];
  signal?: AbortSignal;
  usageContext?: UsageContext;
}

export interface EmbedResponse {
  /** Row-major: embeddings[i] is the float vector for texts[i]. */
  embeddings: number[][];
  dim: number;
  space: EmbeddingSpace;
}

/** Adapter 原始响应；空间身份和归一化只能由 EbdRouter Facade 统一生成。 */
export interface RawEmbedResponse {
  embeddings: number[][];
  dim: number;
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

// ── Probe ─────────────────────────────────────────────────────────────────────

export interface EbdProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}
