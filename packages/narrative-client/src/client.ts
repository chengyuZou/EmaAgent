import type {
  NarrativeRouteRequest,
  NarrativeRouteResponse,
  NarrativeQueryRequest,
  NarrativeQueryResponse,
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
  private readonly baseUrl: string;
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
  async route(query: string): Promise<NarrativeRouteResponse> {
    const body: NarrativeRouteRequest = { query };
    const res = await this.post('/narrative/route', body);
    await this.assertOk(res, 'route');
    return res.json() as Promise<NarrativeRouteResponse>;
  }

  /**
   * Run LightRAG retrieval for each timeline sub-query in parallel.
   */
  async query(
    queries: Record<string, string>,
    mode = 'hybrid',
  ): Promise<NarrativeQueryResponse> {
    const body: NarrativeQueryRequest = { queries, mode };
    const res = await this.post('/narrative/query', body);
    await this.assertOk(res, 'query');
    return res.json() as Promise<NarrativeQueryResponse>;
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

  // ── Internals ──────────────────────────────────────────────────────────────

  private post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method:  'POST',
      headers: this.headers,
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async assertOk(res: Response, op: string): Promise<void> {
    if (res.ok) return;
    if (res.status === 503) {
      throw new NarrativeUnavailableError(
        `Bridge narrative not configured (503). POST /internal/configure with llm + embed first.`,
      );
    }
    const text = await res.text().catch(() => '');
    throw new Error(`Bridge narrative/${op} failed: HTTP ${res.status} — ${text}`);
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
