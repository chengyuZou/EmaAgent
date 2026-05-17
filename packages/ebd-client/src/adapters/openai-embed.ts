import type { EmbedProviderConfig, EmbedResponse } from '../types.js';
import type { EmbedAdapter } from './base.js';

/**
 * OpenAI-compatible /embeddings adapter.
 * Compatible with: OpenAI, SiliconFlow, Jina, Voyage, LM Studio, Ollama.
 */
export class OpenAIEmbedAdapter implements EmbedAdapter {
  private readonly config: EmbedProviderConfig;

  constructor(config: EmbedProviderConfig) {
    this.config = config;
  }

  async embed(texts: string[], model: string): Promise<EmbedResponse> {
    const baseUrl = (this.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`openai-embed HTTP ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      data: { embedding: number[]; index: number }[];
    };

    // Sort by index to guarantee order matches input.
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    return {
      embeddings: sorted.map(d => d.embedding),
      dim: this.config.dim,
    };
  }
}
