// ── Embed ─────────────────────────────────────────────────────────────────────

export interface EmbedRequest {
  texts: string[];
}

export interface EmbedResponse {
  /** Row-major: embeddings[i] is the vector for texts[i]. */
  embeddings: number[][];
  dim: number;
}

// ── Rerank ────────────────────────────────────────────────────────────────────

export interface RerankRequest {
  query: string;
  documents: string[];
  topK?: number;
}

export interface RerankItem {
  /** Index into the original documents array. */
  index: number;
  score: number;
}

export interface RerankResponse {
  results: RerankItem[];
}

// ── Configure ─────────────────────────────────────────────────────────────────

/**
 * Embed-side provider config sent to bridge.
 *
 * `protocol` selects which embedder implementation to instantiate.
 * Currently only `'openai-embed'` is supported.
 */
export interface EmbedProviderCfg {
  protocol: 'openai-embed';
  apiKey: string;
  baseUrl: string;
  model: string;
  dim?: number;        // default: 1024
}

/**
 * Rerank-side provider config sent to bridge.
 * All major rerank vendors (Cohere, Jina, SiliconFlow) share one wire format,
 * so no `protocol` field is needed.
 */
export interface RerankProviderCfg {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface LlmProviderCfg {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface BridgeConfigurePayload {
  embed?:  EmbedProviderCfg;
  rerank?: RerankProviderCfg;
  llm?:    LlmProviderCfg;
}

// ── Health ────────────────────────────────────────────────────────────────────

export interface BridgeCapabilities {
  embed:     boolean;
  rerank:    boolean;
  llm:       boolean;
  narrative: boolean;
}

export interface BridgeHealthResponse {
  status: 'ok';
  version: string;
  capabilities: BridgeCapabilities;
}
