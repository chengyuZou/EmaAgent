import { OpenAIEmbedAdapter }  from './adapters/openai-embed.js';
import { GeminiEmbedAdapter }  from './adapters/gemini-embed.js';
import { CohereRerankAdapter } from './adapters/cohere-rerank.js';
import type { EmbedAdapter, RerankAdapter } from './adapters/base.js';
import type {
  EmbedProviderConfig,
  RerankProviderConfig,
  EmbedRequest,
  EmbedResponse,
  RerankRequest,
  RerankResponse,
  EbdProbeResult,
} from './types.js';
import { createEmbeddingSpace, type EmbeddingSpace } from './embedding-space.js';

function createEmbedAdapter(config: EmbedProviderConfig): EmbedAdapter {
  switch (config.protocol) {
    case 'openai-embed': return new OpenAIEmbedAdapter(config);
    case 'gemini-embed': return new GeminiEmbedAdapter(config);
  }
}

function createRerankAdapter(config: RerankProviderConfig): RerankAdapter {
  switch (config.protocol) {
    case 'cohere-rerank': return new CohereRerankAdapter(config);
  }
}

/**
 * Single Facade for all embedding and reranking.
 *
 * Keyed by provider_configs.id UUID — multiple providers can share the same
 * protocol (e.g. SiliconFlow + OpenAI are both 'openai-embed').
 *
 * Calls provider APIs directly from TS — no Python bridge involved.
 */
export class EbdRouter {
  private embedAdapters = new Map<string, EmbedAdapter>();
  private embedConfigs  = new Map<string, EmbedProviderConfig>();
  private rerankAdapters = new Map<string, RerankAdapter>();
  private rerankConfigs  = new Map<string, RerankProviderConfig>();

  constructor(
    embedConfigs:  EmbedProviderConfig[]  = [],
    rerankConfigs: RerankProviderConfig[] = [],
  ) {
    for (const c of embedConfigs)  this.upsertEmbedConfig(c);
    for (const c of rerankConfigs) this.upsertRerankConfig(c);
  }

  // ── Embed ──────────────────────────────────────────────────────────────────

  /** 使用完整快照同时替换 Embed 与 Rerank Adapter。 */
  reload(
    embedConfigs: EmbedProviderConfig[],
    rerankConfigs: RerankProviderConfig[],
  ): void {
    const nextEmbedConfigs = new Map<string, EmbedProviderConfig>();
    const nextEmbedAdapters = new Map<string, EmbedAdapter>();
    const nextRerankConfigs = new Map<string, RerankProviderConfig>();
    const nextRerankAdapters = new Map<string, RerankAdapter>();

    for (const config of embedConfigs) {
      nextEmbedConfigs.set(config.id, config);
      nextEmbedAdapters.set(config.id, createEmbedAdapter(config));
    }
    for (const config of rerankConfigs) {
      nextRerankConfigs.set(config.id, config);
      nextRerankAdapters.set(config.id, createRerankAdapter(config));
    }

    this.embedConfigs = nextEmbedConfigs;
    this.embedAdapters = nextEmbedAdapters;
    this.rerankConfigs = nextRerankConfigs;
    this.rerankAdapters = nextRerankAdapters;
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const adapter = this.embedAdapters.get(req.providerId);
    if (!adapter) throw new Error(`ebd/embed: no provider registered for id "${req.providerId}"`);
    const config = this.embedConfigs.get(req.providerId)!;
    const raw = await adapter.embed(req.texts, req.model, req.signal);
    validateEmbedResponse(req.texts.length, raw.embeddings, raw.dim);
    const space = createEmbeddingSpace({
      providerId: req.providerId,
      model: req.model,
      dim: raw.dim,
      normalization: 'l2',
      revision: config.embeddingRevision,
    });
    return {
      embeddings: raw.embeddings.map(normalizeEmbedding),
      dim: raw.dim,
      space,
    };
  }

  /** 已知维度时无需调用 Provider 即可解析稳定空间身份。 */
  embeddingSpace(providerId: string, model: string, dim: number): EmbeddingSpace {
    const config = this.embedConfigs.get(providerId);
    if (!config) throw new Error(`ebd/embed: no provider registered for id "${providerId}"`);
    return createEmbeddingSpace({
      providerId,
      model,
      dim,
      normalization: 'l2',
      revision: config.embeddingRevision,
    });
  }

  upsertEmbedConfig(config: EmbedProviderConfig): void {
    this.embedConfigs.set(config.id, config);
    this.embedAdapters.set(config.id, createEmbedAdapter(config));
  }

  removeEmbedConfig(id: string): void {
    this.embedConfigs.delete(id);
    this.embedAdapters.delete(id);
  }

  firstEmbedId(): string | undefined {
    return this.embedConfigs.keys().next().value as string | undefined;
  }

  defaultEmbedModelFor(providerId: string): string | undefined {
    return this.embedConfigs.get(providerId)?.defaultModel;
  }

  // ── Rerank ─────────────────────────────────────────────────────────────────

  async rerank(req: RerankRequest): Promise<RerankResponse> {
    const adapter = this.rerankAdapters.get(req.providerId);
    if (!adapter) throw new Error(`ebd/rerank: no provider registered for id "${req.providerId}"`);
    return adapter.rerank(req.query, req.documents, req.topK ?? 5, req.model, req.signal);
  }

  upsertRerankConfig(config: RerankProviderConfig): void {
    this.rerankConfigs.set(config.id, config);
    this.rerankAdapters.set(config.id, createRerankAdapter(config));
  }

  removeRerankConfig(id: string): void {
    this.rerankConfigs.delete(id);
    this.rerankAdapters.delete(id);
  }

  firstRerankId(): string | undefined {
    return this.rerankConfigs.keys().next().value as string | undefined;
  }

  defaultRerankModelFor(providerId: string): string | undefined {
    return this.rerankConfigs.get(providerId)?.defaultModel;
  }

  // ── Probe ──────────────────────────────────────────────────────────────────

  async probeEmbed(providerId: string, model: string): Promise<EbdProbeResult> {
    const adapter = this.embedAdapters.get(providerId);
    if (!adapter) return { ok: false, error: `no embed provider registered for "${providerId}"` };
    const start = Date.now();
    try {
      await adapter.embed(['ping'], model);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: (e as Error).message };
    }
  }

  async probeRerank(providerId: string, model: string): Promise<EbdProbeResult> {
    const adapter = this.rerankAdapters.get(providerId);
    if (!adapter) return { ok: false, error: `no rerank provider registered for "${providerId}"` };
    const start = Date.now();
    try {
      await adapter.rerank('test', ['doc'], 1, model);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, error: (e as Error).message };
    }
  }
}

function validateEmbedResponse(expectedCount: number, embeddings: number[][], dim: number): void {
  if (!Number.isSafeInteger(dim) || dim <= 0) {
    throw new Error(`ebd/embed: invalid dimension ${dim}`);
  }
  if (embeddings.length !== expectedCount) {
    throw new Error(`ebd/embed: response count mismatch ${embeddings.length}/${expectedCount}`);
  }
  for (const vector of embeddings) {
    if (vector.length !== dim || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`ebd/embed: malformed ${vector.length}-dimensional vector, expected ${dim}`);
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
