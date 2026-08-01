import { randomUUID } from 'node:crypto';
import type { EmbedRuntime, EmbeddingSpace } from '@ema-agent/embed';
import type { RerankRuntime } from '@ema-agent/rerank';
import { packEmbedding, normalizeQueryVector } from './similarity.js';
import type { EmbeddedText } from '../types.js';
import type { MemoryModelSettings } from '../settings.js';

export class EmbedService {
  constructor(
    private readonly embedRuntime:   EmbedRuntime,
    private readonly rerankRuntime:  RerankRuntime,
    private readonly readModels: () => MemoryModelSettings,
  ) {}

  /** 每次操作读取当前 Embed 设置，让设置更新无需重建 MemoryPlanner。 */
  resolveEmbed(): { providerId: string; model: string } | null {
    const selected = this.readModels().embed;
    return selected
      ? { providerId: selected.providerConfigId, model: selected.model }
      : null;
  }

  private resolveRerank(): { providerId: string; model: string } | null {
    const selected = this.readModels().rerank;
    return selected
      ? { providerId: selected.providerConfigId, model: selected.model }
      : null;
  }

  /** 是否已经选择可用的 Embed 模型。 */
  isAvailable(): boolean { return this.resolveEmbed() !== null; }

  /** 新向量写入时记录的 Provider 配置实例身份。 */
  currentProviderId(): string | undefined { return this.resolveEmbed()?.providerId; }

  /** 由当前配置和 catalog 维度解析空间，不从历史向量反推身份。 */
  currentSpace(dim: number): EmbeddingSpace | null {
    const p = this.resolveEmbed();
    return p ? this.embedRuntime.embeddingSpace(p.providerId, p.model, dim) : null;
  }

  async embedOne(text: string, signal?: AbortSignal): Promise<EmbeddedText | null> {
    const result = await this.embedMany([text], signal);
    if (!result) return null;
    return result[0] ?? null;
  }

  async embedMany(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<EmbeddedText[] | null> {
    if (texts.length === 0) return [];
    const p = this.resolveEmbed();
    if (!p) return null;

    const resp = await this.embedRuntime.embed({
      providerId: p.providerId,
      model: p.model,
      texts,
      signal,
    });
    return resp.embeddings.map((vec) => ({
      embedding:  packEmbedding(vec),
      providerId: p.providerId,
      model:      p.model,
      dim:        resp.dim,
      space:      resp.space,
    }));
  }

  /** 同时返回落库 BLOB 和用于 ANN 检索的归一化向量。 */
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

  /**
   * 返回原始下标到分数的映射；未配置或调用失败时返回 null，让召回链自然降级。
   * usage 携带本次召回的 Turn 身份，让 rerank 用量记录归属到会话与轮次。
   */
  async rerank(
    query:     string,
    documents: string[],
    topK:      number,
    signal?:   AbortSignal,
    usage?:    { sessionId?: string; turnId?: string },
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
        usageContext: usage
          ? { callId: randomUUID(), sessionId: usage.sessionId, turnId: usage.turnId }
          : undefined,
      });
      return new Map(resp.results.map(r => [r.index, r.score]));
    } catch {
      return null;
    }
  }
}
