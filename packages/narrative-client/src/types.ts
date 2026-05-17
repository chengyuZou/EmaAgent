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
