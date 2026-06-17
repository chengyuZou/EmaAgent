import type { EmbedResponse, RerankResponse } from '../types.js';

export interface EmbedAdapter {
  embed(texts: string[], model: string, signal?: AbortSignal): Promise<EmbedResponse>;
}

export interface RerankAdapter {
  rerank(query: string, documents: string[], topK: number, model: string, signal?: AbortSignal): Promise<RerankResponse>;
}
