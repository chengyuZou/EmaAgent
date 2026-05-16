import type {
  EmbedRequest,
  EmbedResponse,
  RerankRequest,
  RerankResponse,
  BridgeConfigurePayload,
  BridgeHealthResponse,
} from './types.js';

export interface RetrievalClientOptions {
  /** Bridge base URL. Default: http://127.0.0.1:7421 */
  baseUrl?: string;
  /** Shared secret sent as X-Ema-Secret header. */
  secret?: string;
  /** Request timeout in ms. Default: 30_000 */
  timeoutMs?: number;
}

/**
 * Façade for the Python bridge's embedding and reranking endpoints.
 *
 * Lifecycle:
 *   1. Instantiate with bridge base URL + optional shared secret.
 *   2. Call `configure()` once at startup to push provider credentials.
 *   3. Call `embed()` / `rerank()` as needed — bridge returns 503 if not configured.
 *   4. Call `health()` to check which capabilities are ready.
 *
 * All methods throw on HTTP errors or network failure.
 * Callers should handle `RetrievalUnavailableError` for graceful degradation.
 */
export class RetrievalClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts: RetrievalClientOptions = {}) {
    this.baseUrl  = (opts.baseUrl ?? 'http://127.0.0.1:7421').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.headers = {
      'Content-Type': 'application/json',
      ...(opts.secret ? { 'X-Ema-Secret': opts.secret } : {}),
    };
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  /**
   * Push provider configuration to the bridge.
   * Call this on startup and whenever provider settings change in the UI.
   * Safe to call if bridge is down — returns false instead of throwing.
   */
  async configure(payload: BridgeConfigurePayload): Promise<boolean> {
    try {
      const res = await this.post('/internal/configure', payload);
      return res.ok;
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

  // ── Embed ──────────────────────────────────────────────────────────────────

  /**
   * Embed a batch of texts. Returns row-major float matrix.
   *
   * @throws {RetrievalUnavailableError} when bridge is down or not configured.
   */
  async embed(texts: string[]): Promise<EmbedResponse> {
    const res = await this.post('/embed', { texts } satisfies EmbedRequest);
    await this.assertOk(res, 'embed');
    return res.json() as Promise<EmbedResponse>;
  }

  // ── Rerank ─────────────────────────────────────────────────────────────────

  /**
   * Re-rank documents by relevance to query.
   * Returns results sorted by score descending, truncated to topK.
   *
   * @throws {RetrievalUnavailableError} when bridge is down or not configured.
   */
  async rerank(req: RerankRequest): Promise<RerankResponse> {
    const body = {
      query: req.query,
      documents: req.documents,
      top_k: req.topK ?? 5,
    };
    const res = await this.post('/rerank', body);
    await this.assertOk(res, 'rerank');
    return res.json() as Promise<RerankResponse>;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async assertOk(res: Response, op: string): Promise<void> {
    if (res.ok) return;
    if (res.status === 503) {
      throw new RetrievalUnavailableError(
        `Bridge ${op} provider not configured (503). Call configure() first.`,
      );
    }
    const text = await res.text().catch(() => '');
    throw new Error(`Bridge ${op} failed: HTTP ${res.status} — ${text}`);
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Thrown when the bridge is reachable but the requested capability
 * (embed / rerank) is not yet configured.
 * Callers can catch this to gracefully degrade without crashing the turn.
 */
export class RetrievalUnavailableError extends Error {
  override readonly name = 'RetrievalUnavailableError';
  constructor(message: string) {
    super(message);
  }
}
