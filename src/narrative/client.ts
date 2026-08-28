// 封装 Core 调用 Python Bridge 的 Narrative 查询与进程管理协议。
import type {
  NarrativeBridgeConfigureRequest,
  NarrativeRecallRequest,
  NarrativeRecallResponse,
} from './types.js';
import {
  NarrativeClientError,
  NarrativeRequestError,
  NarrativeUnavailableError,
} from './errors.js';

export interface NarrativeClientOptions {
  /** Bridge base URL，由 Rust Host 经 EMA_NARRATIVE_BRIDGE_URL 下发。 */
  baseUrl: string;
  /** Shared secret sent as X-Ema-Secret header. */
  secret?: string;
  timeoutMs?: number;
}

export class NarrativeClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts: NarrativeClientOptions) {
    this.baseUrl   = opts.baseUrl.replace(/\/$/, '');
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

  /**
   * 送达进程级 Embedding 连接；Bridge 建完时间线实例才返回，可能耗时数秒。
   * 409 = Bridge 已持有配置（Server 单独重启场景），对调用方等同可用。
   */
  async configure(payload: NarrativeBridgeConfigureRequest): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/configure`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(this.timeoutMs),
      });
      return res.ok || res.status === 409;
    } catch {
      return false;
    }
  }

  /**  Bridge 退出；Bridge 不在场时返回 false，由调用方按降级处理。 */
  async shutdown(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/shutdown`, {
        method:  'POST',
        headers: this.headers,
        signal:  AbortSignal.timeout(10_000),
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
            status: res.status,
          },
        );
      }
      try {
        return await res.json() as T;
      } catch (error) {
        throw new NarrativeRequestError('Narrative Bridge returned invalid JSON.', {
          code: 'narrative/invalid_response',
          cause: error,
        });
      }
    } catch (err) {
      if (err instanceof NarrativeClientError) throw err;
      if (externalSignal?.aborted) throw externalSignal.reason ?? err;
      if (timeoutSignal.aborted) {
        throw new NarrativeRequestError(`Narrative Bridge request timed out: ${path}`, {
          code: 'narrative/timeout',
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
