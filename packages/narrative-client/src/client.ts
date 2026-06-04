import type {
  BridgeConfigurePayload,
  BridgeHealthResponse,
  NarrativeRouteResponse,
  NarrativeQueryResponse,
  NarrativeIngestResponse,
} from './types.js';

export interface NarrativeClientOptions {
  /** Bridge base URL. Default: http://127.0.0.1:7421 */
  baseUrl?: string;
  /** Shared secret sent as X-Ema-Secret header. */
  secret?: string;
  /**
   * Request timeout in ms for route + query calls.
   * Route involves an LLM call; query involves parallel LightRAG lookups.
   * Default: 60_000
   */
  timeoutMs?: number;
}

/**
 * Façade for the Python bridge's narrative endpoints.
 *
 * Typical narrative turn flow:
 *   1. `route(query)`  — LLM selects timelines + rewrites sub-queries.
 *                        Emit result as SSE event for frontend display.
 *   2. `query(routes)` — parallel LightRAG retrieval across selected timelines.
 *   3. Merge results into the ConversationEngine context.
 *
 * All methods throw `NarrativeUnavailableError` when the bridge is down or
 * narrative is not yet configured (503). Catch this to degrade gracefully.
 */
export class NarrativeClient {
  private baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts: NarrativeClientOptions = {}) {
    this.baseUrl   = (opts.baseUrl ?? 'http://127.0.0.1:7421').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.headers   = {
      'Content-Type': 'application/json',
      ...(opts.secret ? { 'X-Ema-Secret': opts.secret } : {}),
    };
  }

  /**
   * Route a user query to relevant timelines and rewrite sub-queries.
   * Involves one LLM call on the bridge side.
   */
  async route(query: string, signal?: AbortSignal): Promise<NarrativeRouteResponse> {
    return this.post<NarrativeRouteResponse>('/narrative/route', { query }, signal);
  }

  /**
   * Run LightRAG retrieval for each timeline sub-query in parallel.
   * All timelines are sent in one request; Python bridge gathers them.
   */
  async query(
    queries: Record<string, string>,
    mode = 'hybrid',
    signal?: AbortSignal,
  ): Promise<NarrativeQueryResponse> {
    return this.post<NarrativeQueryResponse>('/narrative/query', { queries, mode }, signal);
  }

  /**
   * Ingest documents into a specific timeline's LightRAG knowledge graph.
   * LightRAG deduplicates by content hash — safe to call repeatedly.
   * Throws NarrativeUnavailableError if bridge is not ready.
   */
  async ingest(
    timeline: string,
    documents: string[],
    signal?: AbortSignal,
  ): Promise<NarrativeIngestResponse> {
    return this.post<NarrativeIngestResponse>('/narrative/ingest', { timeline, documents }, signal);
  }

  /**
   * Run LightRAG retrieval for a single timeline.
   * Call this concurrently per-timeline so results stream back as each finishes.
   */
  async queryOne(timeline: string, query: string, signal?: AbortSignal): Promise<string> {
    const resp = await this.query({ [timeline]: query }, 'hybrid', signal);
    return resp.results[timeline] ?? '';
  }

  /**
   * Check whether the bridge's narrative capability is ready.
   * Returns false when the bridge is unreachable.
   */
  async isReady(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return false;
      const data = await res.json() as { capabilities?: { narrative?: boolean } };
      return data.capabilities?.narrative === true;
    } catch {
      return false;
    }
  }

  // ── URL hot-update ────────────────────────────────────────────────────────

  /**
   * Update the base URL at runtime.
   * Called by apps/core before each configureBridge() so the client always
   * points at the port the bridge actually chose (read from bridge.port file).
   */
  updateBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
  }

  // ── Bridge admin ───────────────────────────────────────────────────────────

  /**
   * Push LightRAG config (embed + llm) to the bridge.
   * Called by apps/core on startup and whenever relevant bindings change.
   * Returns false if the bridge is unreachable — safe to ignore.
   */
  async configure(payload: BridgeConfigurePayload): Promise<boolean> {
    try {
      await this.post('/internal/configure', payload);
      return true;
    } catch {
      return false;
    }
  }

  async health(): Promise<BridgeHealthResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      return res.json() as Promise<BridgeHealthResponse>;
    } catch {
      return null;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async post<T>(path: string, body: unknown, externalSignal?: AbortSignal): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = externalSignal
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        throw new NarrativeUnavailableError(
          `Bridge narrative not configured or unavailable (HTTP ${res.status}).`,
        );
      }
      return await res.json() as T;
    } catch (err) {
      if (err instanceof NarrativeUnavailableError) throw err;
      if (err instanceof Error && err.name === 'AbortError')  throw err;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;

      throw new NarrativeUnavailableError(
        `Failed to ${path} on bridge: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Thrown when the bridge is reachable but narrative is not yet configured,
 * or the bridge is down entirely.
 * Catch this in ConversationEngine to fall back to non-RAG chat.
 */
export class NarrativeUnavailableError extends Error {
  override readonly name = 'NarrativeUnavailableError';
  constructor(message: string) {
    super(message);
  }
}
