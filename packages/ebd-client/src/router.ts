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
 * Single Façade for all embedding and reranking.
 *
 * Keyed by provider_configs.id UUID — multiple providers can share the same
 * protocol (e.g. SiliconFlow + OpenAI are both 'openai-embed').
 *
 * Calls provider APIs directly from TS — no Python bridge involved.
 */
export class EbdRouter {
  private readonly embedAdapters = new Map<string, EmbedAdapter>();
  private readonly embedConfigs  = new Map<string, EmbedProviderConfig>();
  private readonly rerankAdapters = new Map<string, RerankAdapter>();
  private readonly rerankConfigs  = new Map<string, RerankProviderConfig>();

  constructor(
    embedConfigs:  EmbedProviderConfig[]  = [],
    rerankConfigs: RerankProviderConfig[] = [],
  ) {
    for (const c of embedConfigs)  this.upsertEmbedConfig(c);
    for (const c of rerankConfigs) this.upsertRerankConfig(c);
  }

  // ── Embed ──────────────────────────────────────────────────────────────────

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const adapter = this.embedAdapters.get(req.providerId);
    if (!adapter) throw new Error(`ebd/embed: no provider registered for id "${req.providerId}"`);
    return adapter.embed(req.texts, req.model, req.signal);
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
