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

export interface EmbedProviderCfg {
  provider?: string;   // default: "openai-compat"
  apiKey: string;
  baseUrl: string;
  model: string;
  dim?: number;        // default: 1024
}

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
  embed:  boolean;
  rerank: boolean;
  llm:    boolean;
}

export interface BridgeHealthResponse {
  status: 'ok';
  version: string;
  capabilities: BridgeCapabilities;
}
