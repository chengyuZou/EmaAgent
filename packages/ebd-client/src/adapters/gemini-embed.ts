import type { EmbedProviderConfig, EmbedResponse } from '../types.js';
import type { EmbedAdapter } from './base.js';

/**
 * Google Gemini embedding adapter.
 * Uses batchEmbedContents for efficiency (single round-trip for multiple texts).
 *
 * API reference:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents
 *   Authorization is sent with x-goog-api-key so credentials do not appear in
 *   URLs, logs, or devtool network query strings.
 */
export class GeminiEmbedAdapter implements EmbedAdapter {
  private readonly config: EmbedProviderConfig;

  constructor(config: EmbedProviderConfig) {
    this.config = config;
  }

  async embed(texts: string[], model: string): Promise<EmbedResponse> {
    const baseUrl = (
      this.config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/$/, '');

    const url = `${baseUrl}/models/${model}:batchEmbedContents`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.apiKey,
      },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`gemini-embed HTTP ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      embeddings: { values: number[] }[];
    };

    return {
      embeddings: data.embeddings.map(e => e.values),
      dim: this.config.dim,
    };
  }
}
