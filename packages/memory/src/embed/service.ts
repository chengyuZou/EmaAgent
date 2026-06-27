import type { EbdRouter } from '@ema-agent/ebd-client';
import { packEmbedding, normalizeQueryVector } from './similarity.js';
import type { EmbeddedText, MemoryModelRef } from '../types.js';

export class EmbedService {
  constructor(
    private readonly ebd:            EbdRouter,
    private readonly embedOverride?:  MemoryModelRef,
    private readonly rerankOverride?: MemoryModelRef,
  ) {}

  // ── Provider resolution ───────────────────────────────────────────────────

  /** Resolve the active embed provider+model. Public — IndexManager uses it. */
  resolveEmbed(): { providerId: string; model: string } | null {
    if (this.embedOverride) return this.embedOverride;
    const providerId = this.ebd.firstEmbedId();
    if (!providerId) return null;
    const model = this.ebd.defaultEmbedModelFor(providerId);
    return model ? { providerId, model } : null;
  }

  private resolveRerank(): { providerId: string; model: string } | null {
    if (this.rerankOverride) return this.rerankOverride;
    const providerId = this.ebd.firstRerankId();
    if (!providerId) return null;
    const model = this.ebd.defaultRerankModelFor(providerId);
    return model ? { providerId, model } : null;
  }

  // ── Embed ─────────────────────────────────────────────────────────────────

  /** True iff at least one embed provider is configured with a model. */
  isAvailable(): boolean { return this.resolveEmbed() !== null; }

  /** Active embed provider id, used to stamp `embedding_provider_id` on new rows. */
  currentProviderId(): string | undefined { return this.resolveEmbed()?.providerId; }

  async embedOne(text: string): Promise<EmbeddedText | null> {
    const result = await this.embedMany([text]);
    if (!result) return null;
    return result[0] ?? null;
  }

  async embedMany(texts: string[]): Promise<EmbeddedText[] | null> {
    if (texts.length === 0) return [];
    const p = this.resolveEmbed();
    if (!p) return null;

    const resp = await this.ebd.embed({ providerId: p.providerId, model: p.model, texts });
    return resp.embeddings.map((vec) => ({
      embedding:  packEmbedding(vec),
      providerId: p.providerId,
      model:      p.model,
      dim:        resp.dim,
    }));
  }

  /**
   * Embed a single query and return both the packed BLOB (for stamping provenance)
   * and the normalized Float32Array (for index.search / dotProduct).
   */
  async embedQuery(text: string): Promise<{ queryVec: Float32Array; embedded: EmbeddedText } | null> {
    const p = this.resolveEmbed();
    if (!p) return null;

    const resp = await this.ebd.embed({ providerId: p.providerId, model: p.model, texts: [text] });
    const raw  = resp.embeddings[0];
    if (!raw) return null;

    const queryVec = normalizeQueryVector(raw);
    return {
      queryVec,
      embedded: {
        embedding:  Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength),
        providerId: p.providerId,
        model:      p.model,
        dim:        resp.dim,
      },
    };
  }

  // ── Rerank ────────────────────────────────────────────────────────────────

  /**
   * Rerank `documents` against `query`. Returns a Map<originalIndex, score>
   * so callers never need to import ebd-client types.
   * Returns null when no rerank provider is configured or the call fails.
   */
  async rerank(
    query:     string,
    documents: string[],
    topK:      number,
    signal?:   AbortSignal,
  ): Promise<Map<number, number> | null> {
    const p = this.resolveRerank();
    if (!p) return null;
    try {
      const resp = await this.ebd.rerank({
        providerId: p.providerId,
        model:      p.model,
        query,
        documents,
        topK,
        signal,
      });
      return new Map(resp.results.map(r => [r.index, r.score]));
    } catch {
      return null;
    }
  }
}
