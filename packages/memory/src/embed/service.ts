import type { EmbedRuntime, EmbeddingSpace } from '@ema-agent/embed';
import type { RerankRuntime } from '@ema-agent/rerank';
import { packEmbedding, normalizeQueryVector } from './similarity.js';
import type { EmbeddedText, MemoryModelRef } from '../types.js';

export class EmbedService {
  constructor(
    private readonly embedRuntime:   EmbedRuntime,
    private readonly rerankRuntime:  RerankRuntime,
    private readonly embedOverride?:  MemoryModelRef,
    private readonly rerankOverride?: MemoryModelRef,
  ) {}

  // ── Provider resolution ───────────────────────────────────────────────────

  /** Resolve the active embed provider+model. Public — IndexManager uses it. */
  resolveEmbed(): { providerId: string; model: string } | null {
    return this.embedOverride ?? null;
  }

  private resolveRerank(): { providerId: string; model: string } | null {
    return this.rerankOverride ?? null;
  }

  // ── Embed ─────────────────────────────────────────────────────────────────

  /** True iff at least one embed provider is configured with a model. */
  isAvailable(): boolean { return this.resolveEmbed() !== null; }

  /** Active embed provider id, used to stamp `embedding_provider_id` on new rows. */
  currentProviderId(): string | undefined { return this.resolveEmbed()?.providerId; }

  /** 由当前配置和 catalog 维度解析空间，不从历史向量反推身份。 */
  currentSpace(dim: number): EmbeddingSpace | null {
    const p = this.resolveEmbed();
    return p ? this.embedRuntime.embeddingSpace(p.providerId, p.model, dim) : null;
  }

  async embedOne(text: string): Promise<EmbeddedText | null> {
    const result = await this.embedMany([text]);
    if (!result) return null;
    return result[0] ?? null;
  }

  async embedMany(texts: string[]): Promise<EmbeddedText[] | null> {
    if (texts.length === 0) return [];
    const p = this.resolveEmbed();
    if (!p) return null;

    const resp = await this.embedRuntime.embed({ providerId: p.providerId, model: p.model, texts });
    return resp.embeddings.map((vec) => ({
      embedding:  packEmbedding(vec),
      providerId: p.providerId,
      model:      p.model,
      dim:        resp.dim,
      space:      resp.space,
    }));
  }

  /**
   * Embed a single query and return both the packed BLOB (for stamping provenance)
   * and the normalized Float32Array (for index.search / dotProduct).
   */
  async embedQuery(text: string): Promise<{ queryVec: Float32Array; embedded: EmbeddedText } | null> {
    const p = this.resolveEmbed();
    if (!p) return null;

    const resp = await this.embedRuntime.embed({ providerId: p.providerId, model: p.model, texts: [text] });
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
        space:      resp.space,
      },
    };
  }

  // ── Rerank ────────────────────────────────────────────────────────────────

  /**
   * Rerank `documents` against `query`. Returns a Map<originalIndex, score>
   * so callers never need to import Rerank 模块类型。
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
      const resp = await this.rerankRuntime.rerank({
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
