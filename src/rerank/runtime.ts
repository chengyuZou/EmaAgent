// 执行 Rerank 请求，并维护配置、Adapter 与 Usage 的原子运行时入口。
import { createUsageRecord, reportUsage } from '@ema-agent/usage';
import { CohereRerankAdapter } from './adapters/cohere.js';
import { withOneRetry } from './retry.js';
import type {
  RerankAdapter,
  RerankItem,
  RerankProbeResult,
  RerankProviderConfig,
  RerankRequest,
  RerankResponse,
  RerankRuntimeOptions,
} from './types.js';

interface RerankRuntimeEntry {
  readonly config: Readonly<RerankProviderConfig>;
  readonly adapter: RerankAdapter;
}

type RerankAdapterFactory = (config: RerankProviderConfig) => RerankAdapter;

export class RerankRuntime {
  private entries = new Map<string, RerankRuntimeEntry>();
  private readonly createAdapter: RerankAdapterFactory;

  constructor(
    configs: readonly RerankProviderConfig[],
    private readonly options: RerankRuntimeOptions,
    createAdapter: RerankAdapterFactory = createProtocolAdapter,
  ) {
    this.createAdapter = createAdapter;
    this.entries = this.buildEntries(configs);
  }

  reload(configs: readonly RerankProviderConfig[]): void {
    this.entries = this.buildEntries(configs, this.entries);
  }

  upsertConfig(config: RerankProviderConfig): void {
    const previous = this.entries.get(config.id);
    if (previous && configsEqual(previous.config, config)) return;
    const next = new Map(this.entries);
    next.set(config.id, this.createEntry(config));
    this.entries = next;
  }

  removeConfig(providerId: string): void {
    if (!this.entries.has(providerId)) return;
    const next = new Map(this.entries);
    next.delete(providerId);
    this.entries = next;
  }

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const entry = this.entries.get(request.providerId);
    if (!entry) throw new Error(`rerank/not_configured: ${request.providerId}`);
    if (request.documents.length === 0) return { results: [] };
    const topK = normalizeTopK(request.topK, request.documents.length);
    const startedAt = Date.now();
    try {
      // 重试只包住 adapter 的网络调用;响应校验在重试之外,校验失败不值得补枪。
      const response = await withOneRetry(
        () => entry.adapter.rerank(
          request.query,
          request.documents,
          topK,
          request.model,
          request.signal,
        ),
        request.signal,
      );
      validateResponse(response, request.documents.length, topK);
      this.recordUsage(request, startedAt, null);
      return { results: normalizeScoresToUnitRange(response.results) };
    } catch (error) {
      this.recordUsage(request, startedAt, usageErrorCode(error));
      throw error;
    }
  }

  /**
   * 除测试之外无任何调用
   */
  getProtocol(providerId: string): RerankProviderConfig['protocol'] | undefined {
    return this.entries.get(providerId)?.config.protocol;
  }

  async probe(providerId: string, model: string, signal?: AbortSignal): Promise<RerankProbeResult> {
    const entry = this.entries.get(providerId);
    if (!entry) return { ok: false, error: 'rerank/not_configured' };
    const startedAt = Date.now();
    try {
      const response = await entry.adapter.rerank('test', ['document'], 1, model, signal);
      validateResponse(response, 1, 1);
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: safeProbeError(error, signal),
      };
    }
  }

  private buildEntries(
    configs: readonly RerankProviderConfig[],
    previous?: ReadonlyMap<string, RerankRuntimeEntry>,
  ): Map<string, RerankRuntimeEntry> {
    const entries = new Map<string, RerankRuntimeEntry>();
    for (const config of configs) {
      if (entries.has(config.id)) throw new Error(`rerank/duplicate_config: ${config.id}`);
      const oldEntry = previous?.get(config.id);
      entries.set(
        config.id,
        oldEntry && configsEqual(oldEntry.config, config) ? oldEntry : this.createEntry(config),
      );
    }
    return entries;
  }

  private createEntry(config: RerankProviderConfig): RerankRuntimeEntry {
    const snapshot = Object.freeze({ ...config });
    return Object.freeze({ config: snapshot, adapter: this.createAdapter(snapshot) });
  }

  private recordUsage(request: RerankRequest, startedAt: number, errorCode: string | null): void {
    const record = createUsageRecord({
      capability: 'rerank',
      providerId: request.providerId,
      modelId: request.model,
      status: errorCode === null ? 'completed' : 'failed',
      startedAt,
      durationMs: Date.now() - startedAt,
      usageContext: request.usageContext,
      quantity: request.documents.length,
      unit: 'document',
      errorCode,
    });
    reportUsage(this.options.usageRecorder, record, this.options.onUsageRecordError);
  }
}

function createProtocolAdapter(config: RerankProviderConfig): RerankAdapter {
  switch (config.protocol) {
    case 'cohere-rerank': return new CohereRerankAdapter(config);
  }
}

function configsEqual(left: Readonly<RerankProviderConfig>, right: RerankProviderConfig): boolean {
  return left.id === right.id
    && left.protocol === right.protocol
    && left.apiKey === right.apiKey
    && left.baseUrl === right.baseUrl;
}

function normalizeTopK(topK: number | undefined, documentCount: number): number {
  if (topK === undefined) return Math.min(5, documentCount);
  if (!Number.isSafeInteger(topK) || topK <= 0) throw new RangeError(`rerank/invalid_top_k: ${topK}`);
  return Math.min(topK, documentCount);
}

/**
 * 把本批 rerank 分数归一到 [0,1]：已全部在区间内时原样返回（保留阈值语义），
 * 出现越界分数时按本批 min-max 映射；分数全部相同且越界时统一映射为 1，
 * 此时相对排序已无意义，不能再让下游误触发低分过滤。
 */
function normalizeScoresToUnitRange(results: RerankItem[]): RerankItem[] {
  if (results.every((item) => item.score >= 0 && item.score <= 1)) return results;
  let min = Infinity;
  let max = -Infinity;
  for (const item of results) {
    min = Math.min(min, item.score);
    max = Math.max(max, item.score);
  }
  if (max === min) {
    return results.map((item) => ({ ...item, score: 1 }));
  }
  const span = max - min;
  return results.map((item) => ({ ...item, score: (item.score - min) / span }));
}

function validateResponse(response: RerankResponse, documentCount: number, topK: number): void {
  if (response.results.length > topK) throw new Error('rerank/too_many_results');
  const seen = new Set<number>();
  for (const item of response.results) {
    if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= documentCount) {
      throw new Error(`rerank/invalid_index: ${item.index}`);
    }
    if (seen.has(item.index)) throw new Error(`rerank/duplicate_index: ${item.index}`);
    if (!Number.isFinite(item.score)) throw new Error(`rerank/invalid_score: ${item.score}`);
    seen.add(item.index);
  }
}

function usageErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    if (error.name === 'AbortError') return 'rerank/aborted';
  }
  return 'rerank/provider_failed';
}

function safeProbeError(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return 'rerank/probe_cancelled';
  const shape = error && typeof error === 'object'
    ? error as { status?: unknown; code?: unknown }
    : undefined;
  if (shape?.status === 401 || shape?.status === 403) return 'rerank/auth_failed';
  if (shape?.status === 404) return 'rerank/model_not_found';
  if (shape?.status === 429) return 'rerank/rate_limited';
  if (typeof shape?.status === 'number' && shape.status >= 500) return 'rerank/unavailable';
  return 'rerank/probe_failed';
}
