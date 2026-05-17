// ── Bridge admin ──────────────────────────────────────────────────────────────

/** Embed config pushed to bridge for LightRAG's internal use. */
export interface BridgeEmbedCfg {
  protocol: 'openai-embed';   // LightRAG bridge only supports openai-compat embed
  apiKey: string;
  baseUrl: string;
  model: string;
  dim?: number;
}

/** LLM config pushed to bridge for LightRAG's entity extraction. */
export interface BridgeLlmCfg {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Payload for POST /internal/configure — no rerank (LightRAG doesn't use it). */
export interface BridgeConfigurePayload {
  embed?: BridgeEmbedCfg;
  llm?:   BridgeLlmCfg;
}

export interface BridgeCapabilities {
  embed:     boolean;
  llm:       boolean;
  narrative: boolean;
}

export interface BridgeHealthResponse {
  status:       'ok';
  version:      string;
  capabilities: BridgeCapabilities;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export interface NarrativeRouteRequest {
  query: string;
}

/**
 * Returned by /narrative/route.
 * TS side should emit this as a `narrative_route_resolved` SSE event so the
 * frontend can display which timelines are being searched.
 */
export interface NarrativeRouteResponse {
  /** timeline → rewritten sub-query for that timeline's RAG search. */
  routes: Record<string, string>;
}

// ── Query ─────────────────────────────────────────────────────────────────────

export interface NarrativeQueryRequest {
  /** Output of NarrativeRouteResponse.routes, or a manually constructed map. */
  queries: Record<string, string>;
  /** LightRAG query mode. Default: 'hybrid'. */
  mode?: string;
}

export interface NarrativeQueryResponse {
  /** timeline → recalled narrative text. */
  results: Record<string, string>;
}
