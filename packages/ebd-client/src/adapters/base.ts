import type { EmbedResponse, RerankResponse } from '../types.js';

export interface EmbedAdapter {
  embed(texts: string[], model: string): Promise<EmbedResponse>;
}

export interface RerankAdapter {
  rerank(query: string, documents: string[], topK: number, model: string): Promise<RerankResponse>;
}
