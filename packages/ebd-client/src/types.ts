import type { EmbedProtocol, RerankProtocol } from '@ema-agent/contracts';

export type { EmbedProtocol, RerankProtocol };

// ── Provider configs ──────────────────────────────────────────────────────────

export interface EmbedProviderConfig {
  /** provider_configs.id UUID — router key. */
  id: string;
  protocol: EmbedProtocol;
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
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
}

export interface EmbedResponse {
  /** Row-major: embeddings[i] is the float vector for texts[i]. */
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
