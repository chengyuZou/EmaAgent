// 封装 Core 调用 Python Bridge 的 Narrative 查询与内部语料维护协议。
import type {
  NarrativeBridgeConfigurePayload,
  NarrativeRecallRequest,
  NarrativeRecallResponse,
} from './types.js';
import {
  NarrativeClientError,
  NarrativeRequestError,
  NarrativeUnavailableError,
} from './errors.js';

export interface NarrativeClientOptions {
  /** Bridge base URL. Default: http://127.0.0.1:7421 */
  baseUrl?: string;
  /** Shared secret sent as X-Ema-Secret header. */
  secret?: string;
  timeoutMs?: number;
}

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

  async recall(
    request: NarrativeRecallRequest,
    signal?: AbortSignal,
  ): Promise<NarrativeRecallResponse> {
    return this.post<NarrativeRecallResponse>('/narrative/recall', request, signal);
  }

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


  updateBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
  }


  /**
   * 注意:bridge 的 /internal/configure 返回 204 No Content(无 body),
   * 不能走通用 post<T>()(它会 res.json() 解析空 body 抛 SyntaxError,
   * 把成功的 204 误判为 unreachable 这里单独处理:只看 res.ok。
   */
  async configure(payload: NarrativeBridgeConfigurePayload): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/configure`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(this.timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
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
        if (res.status === 503) {
          throw new NarrativeUnavailableError(
            `Narrative Bridge is not configured or unavailable (HTTP ${res.status}).`,
            { status: res.status },
          );
        }
        throw new NarrativeRequestError(
          `Narrative Bridge request failed (HTTP ${res.status}).`,
          {
            code: 'narrative/http_error',
            retryable: res.status === 408 || res.status === 429 || res.status >= 500,
            status: res.status,
          },
        );
      }
      try {
        return await res.json() as T;
      } catch (error) {
        throw new NarrativeRequestError('Narrative Bridge returned invalid JSON.', {
          code: 'narrative/invalid_response',
          retryable: false,
          cause: error,
        });
      }
    } catch (err) {
      if (err instanceof NarrativeClientError) throw err;
      if (externalSignal?.aborted) throw externalSignal.reason ?? err;
      if (timeoutSignal.aborted) {
        throw new NarrativeRequestError(`Narrative Bridge request timed out: ${path}`, {
          code: 'narrative/timeout',
          retryable: true,
          cause: err,
        });
      }

      throw new NarrativeUnavailableError(
        `Narrative Bridge request ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}
