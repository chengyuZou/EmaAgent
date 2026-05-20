import type { EbdRouter } from '@ema-agent/ebd-client';
import { packEmbedding, normalizeQueryVector } from './similarity.js';
import type { EmbeddedText } from '../types.js';

/**
 * Thin wrapper that pairs ebd-client with our Buffer packing.
 *
 * Returns `null` when no embed provider is configured — callers must fall back
 * to the LLM-side-query recall path.
 */
export class EmbedService {
  constructor(private readonly ebd: EbdRouter) {}

  /** True iff at least one embed provider is registered and has a default model. */
  isAvailable(): boolean {
    const id = this.ebd.firstEmbedId();
    if (!id) return false;
    return !!this.ebd.defaultEmbedModelFor(id);
  }

  /**
   * Current default embed provider id, used for stamping `embedding_provider_id`
   * on freshly embedded rows so we can detect stale embeddings later.
   */
  currentProviderId(): string | undefined {
    return this.ebd.firstEmbedId();
  }

  async embedOne(text: string): Promise<EmbeddedText | null> {
    const result = await this.embedMany([text]);
    if (!result) return null;
    const [first] = result;
    return first ?? null;
  }

  async embedMany(texts: string[]): Promise<EmbeddedText[] | null> {
    if (texts.length === 0) return [];
    const providerId = this.ebd.firstEmbedId();
    if (!providerId) return null;
    const model = this.ebd.defaultEmbedModelFor(providerId);
    if (!model) return null;

    const resp = await this.ebd.embed({ providerId, model, texts });

    return resp.embeddings.map((vec) => ({
      embedding:  packEmbedding(vec),     // normalized + packed for DB storage
      providerId,
      model,
      dim:        resp.dim,
    }));
  }

  /**
   * Embed a single query and return both the packed BLOB (for stamping the
   * EmbeddedText provenance fields) and the normalized Float32Array view
   * suitable for index.search() / dotProduct(). Saves one unpack round-trip
   * compared to embedOne() + unpackEmbedding().
   */
  async embedQuery(text: string): Promise<{
    queryVec: Float32Array;
    embedded: EmbeddedText;
  } | null> {
    const providerId = this.ebd.firstEmbedId();
    if (!providerId) return null;
    const model = this.ebd.defaultEmbedModelFor(providerId);
    if (!model) return null;

    const resp = await this.ebd.embed({ providerId, model, texts: [text] });
    const raw  = resp.embeddings[0];
    if (!raw) return null;

    const queryVec = normalizeQueryVector(raw);
    return {
      queryVec,
      embedded: {
        embedding:  Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength),
        providerId,
        model,
        dim:        resp.dim,
      },
    };
  }
}
