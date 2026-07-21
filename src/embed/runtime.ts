// 执行 Embedding 请求，并维护配置、Adapter、空间身份与 Usage 的原子运行时入口。
import { randomUUID } from 'node:crypto';
import type { UsageRecord } from '@ema-agent/usage';
import { OpenAiEmbedAdapter } from './adapters/openAi.js';
import { GeminiEmbedAdapter } from './adapters/gemini.js';
import { createEmbeddingSpace, type EmbeddingSpace } from './embeddingSpace.js';
import type {
  EmbedAdapter,
  EmbedProbeResult,
  EmbedProviderConfig,
  EmbedRequest,
  EmbedResponse,
  EmbedRuntimeOptions,
} from './types.js';

interface EmbedRuntimeEntry {
  readonly config: Readonly<EmbedProviderConfig>;
  readonly adapter: EmbedAdapter;
}

type EmbedAdapterFactory = (config: EmbedProviderConfig) => EmbedAdapter;

export class EmbedRuntime {
  private entries = new Map<string, EmbedRuntimeEntry>();
  private readonly createAdapter: EmbedAdapterFactory;

  constructor(
    configs: readonly EmbedProviderConfig[] = [],
    private readonly options: EmbedRuntimeOptions = {},
    createAdapter: EmbedAdapterFactory = createProtocolAdapter,
  ) {
    this.createAdapter = createAdapter;
    this.entries = this.buildEntries(configs);
  }

  reload(configs: readonly EmbedProviderConfig[]): void {
    this.entries = this.buildEntries(configs, this.entries);
  }

  upsertConfig(config: EmbedProviderConfig): void {
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

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const entry = this.entries.get(request.providerId);
    if (!entry) throw new Error(`embed/not_configured: ${request.providerId}`);
    const startedAt = Date.now();
    try {
      const raw = await entry.adapter.embed(request.texts, request.model, request.signal);
      validateResponse(request.texts.length, raw.embeddings, raw.dim);
      const space = createEmbeddingSpace({
        providerId: request.providerId,
        model: request.model,
        dim: raw.dim,
        normalization: 'l2',
        revision: entry.config.embeddingRevision,
      });
      this.recordUsage(request, startedAt, null);
      return {
        embeddings: raw.embeddings.map(normalizeEmbedding),
        dim: raw.dim,
        space,
      };
    } catch (error) {
      this.recordUsage(request, startedAt, usageErrorCode(error));
      throw error;
    }
  }

  embeddingSpace(providerId: string, model: string, dim: number): EmbeddingSpace {
    const entry = this.entries.get(providerId);
    if (!entry) throw new Error(`embed/not_configured: ${providerId}`);
    return createEmbeddingSpace({
      providerId,
      model,
      dim,
      normalization: 'l2',
      revision: entry.config.embeddingRevision,
    });
  }

  getProtocol(providerId: string): EmbedProviderConfig['protocol'] | undefined {
    return this.entries.get(providerId)?.config.protocol;
  }

  async probe(providerId: string, model: string, signal?: AbortSignal): Promise<EmbedProbeResult> {
    const entry = this.entries.get(providerId);
    if (!entry) return { ok: false, error: 'embed/not_configured' };
    const startedAt = Date.now();
    try {
      const response = await entry.adapter.embed(['ping'], model, signal);
      validateResponse(1, response.embeddings, response.dim);
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
    configs: readonly EmbedProviderConfig[],
    previous?: ReadonlyMap<string, EmbedRuntimeEntry>,
  ): Map<string, EmbedRuntimeEntry> {
    const entries = new Map<string, EmbedRuntimeEntry>();
    for (const config of configs) {
      if (entries.has(config.id)) throw new Error(`embed/duplicate_config: ${config.id}`);
      const oldEntry = previous?.get(config.id);
      entries.set(
        config.id,
        oldEntry && configsEqual(oldEntry.config, config) ? oldEntry : this.createEntry(config),
      );
    }
    return entries;
  }

  private createEntry(config: EmbedProviderConfig): EmbedRuntimeEntry {
    const snapshot = Object.freeze({ ...config });
    return Object.freeze({ config: snapshot, adapter: this.createAdapter(snapshot) });
  }

  private recordUsage(request: EmbedRequest, startedAt: number, errorCode: string | null): void {
    const record: UsageRecord = {
      id: request.usageContext?.callId ?? randomUUID(),
      sessionId: request.usageContext?.sessionId ?? null,
      turnId: request.usageContext?.turnId ?? null,
      providerId: request.providerId,
      modelId: request.model,
      capability: 'embed',
      status: errorCode === null ? 'completed' : 'failed',
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      quantity: request.texts.length,
      unit: 'text',
      costUsd: null,
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode,
      createdAt: startedAt,
    };
    try {
      this.options.usageRecorder?.record(record);
    } catch (error) {
      try {
        this.options.onUsageRecordError?.(error, record);
      } catch {
        // 观测链路不得破坏已经完成的模型调用。
      }
    }
  }
}

function createProtocolAdapter(config: EmbedProviderConfig): EmbedAdapter {
  switch (config.protocol) {
    case 'openai-embed': return new OpenAiEmbedAdapter(config);
    case 'gemini-embed': return new GeminiEmbedAdapter(config);
  }
}

function configsEqual(left: Readonly<EmbedProviderConfig>, right: EmbedProviderConfig): boolean {
  return left.id === right.id
    && left.protocol === right.protocol
    && left.apiKey === right.apiKey
    && left.baseUrl === right.baseUrl
    && left.embeddingRevision === right.embeddingRevision;
}

function validateResponse(expectedCount: number, embeddings: number[][], dim: number): void {
  if (!Number.isSafeInteger(dim) || dim <= 0) throw new Error(`embed/invalid_dimension: ${dim}`);
  if (embeddings.length !== expectedCount) {
    throw new Error(`embed/response_count_mismatch: ${embeddings.length}/${expectedCount}`);
  }
  for (const vector of embeddings) {
    if (vector.length !== dim || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`embed/malformed_vector: ${vector.length}/${dim}`);
    }
  }
}

function normalizeEmbedding(vector: number[]): number[] {
  let squared = 0;
  for (const value of vector) squared += value * value;
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm === 0) return [...vector];
  return vector.map((value) => value / norm);
}

function usageErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    if (error.name === 'AbortError') return 'embed/aborted';
  }
  return 'embed/provider_failed';
}

function safeProbeError(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return 'embed/probe_cancelled';
  const shape = error && typeof error === 'object'
    ? error as { status?: unknown; code?: unknown }
    : undefined;
  if (shape?.status === 401 || shape?.status === 403) return 'embed/auth_failed';
  if (shape?.status === 404) return 'embed/model_not_found';
  if (shape?.status === 429) return 'embed/rate_limited';
  if (typeof shape?.status === 'number' && shape.status >= 500) return 'embed/unavailable';
  return 'embed/probe_failed';
}
