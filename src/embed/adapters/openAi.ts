// 调用 OpenAI 兼容的 Embeddings HTTP 协议并保持输入与向量顺序一致。
import type { EmbedAdapter, EmbedProviderConfig, RawEmbedResponse } from '../types.js';

export class OpenAiEmbedAdapter implements EmbedAdapter {
  constructor(private readonly config: EmbedProviderConfig) {}

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<RawEmbedResponse> {
    const baseUrl = (this.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw Object.assign(new Error(`openai-embed HTTP ${response.status}: ${body}`), {
        status: response.status,
      });
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    const embeddings = [...data.data]
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);
    return { embeddings, dim: embeddings[0]?.length ?? 0 };
  }
}
