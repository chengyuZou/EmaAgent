// 调用 Gemini batchEmbedContents 协议，凭据只通过 Header 发送。
import type { EmbedAdapter, EmbedProviderConfig, RawEmbedResponse } from '../types.js';

export class GeminiEmbedAdapter implements EmbedAdapter {
  constructor(private readonly config: EmbedProviderConfig) {}

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<RawEmbedResponse> {
    const baseUrl = (
      this.config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/$/, '');
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(`${baseUrl}/models/${model}:batchEmbedContents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.apiKey,
      },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw Object.assign(new Error(`gemini-embed HTTP ${response.status}: ${body}`), {
        status: response.status,
      });
    }

    const data = await response.json() as { embeddings: Array<{ values: number[] }> };
    const embeddings = data.embeddings.map((item) => item.values);
    return { embeddings, dim: embeddings[0]?.length ?? 0 };
  }
}
