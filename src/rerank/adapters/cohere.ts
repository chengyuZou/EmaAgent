// 调用 Cohere 兼容的 Rerank HTTP 协议并统一 relevance score。
import type { RerankAdapter, RerankProviderConfig, RerankResponse } from '../types.js';

export class CohereRerankAdapter implements RerankAdapter {
  constructor(private readonly config: RerankProviderConfig) {}

  async rerank(
    query: string,
    documents: string[],
    topK: number,
    model: string,
    signal?: AbortSignal,
  ): Promise<RerankResponse> {
    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(`${baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model, query, documents, top_n: topK }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw Object.assign(new Error(`cohere-rerank HTTP ${response.status}: ${body}`), {
        status: response.status,
      });
    }

    const data = await response.json() as {
      results: Array<{ index: number; relevance_score?: number; score?: number }>;
    };
    return {
      results: data.results
        .map((item) => ({
          index: item.index,
          score: item.relevance_score ?? item.score ?? 0,
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, topK),
    };
  }
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const normalized = baseUrl?.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('rerank/base_url_required');
  return normalized;
}
