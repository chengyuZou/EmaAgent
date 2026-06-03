import type { RerankProviderConfig, RerankResponse } from '../types.js';
import type { RerankAdapter } from './base.js';

/**
 * Cohere-style rerank adapter.
 * Compatible with: Cohere, SiliconFlow, Jina, Voyage.
 *
 * Wire format:
 *   POST {baseUrl}/rerank
 *   { model, query, documents: string[], top_n }
 *   → { results: [{ index, relevance_score }] }
 */
function normalizeBaseUrl(baseUrl: string | undefined): string {
  const clean = baseUrl?.trim().replace(/\/+$/, '');
  if (!clean) {
    throw new Error('cohere-rerank: baseUrl is required for the Cohere rerank protocol');
  }
  return clean;
}

export class CohereRerankAdapter implements RerankAdapter {
  private readonly config: RerankProviderConfig;

  constructor(config: RerankProviderConfig) {
    this.config = config;
  }

  async rerank(
    query: string,
    documents: string[],
    topK: number,
    model: string,
  ): Promise<RerankResponse> {
    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    const res = await fetch(`${baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model, query, documents, top_n: topK }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`cohere-rerank HTTP ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      results: { index: number; relevance_score?: number; score?: number }[];
    };

    const results = data.results
      .map(r => ({
        index: r.index,
        score: r.relevance_score ?? r.score ?? 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return { results };
  }
}
