import { defineProvider } from '../types.js';

export const provider = defineProvider({
  id: 'jina',
  name: 'Jina AI',
  defaultBaseUrl: 'https://api.jina.ai/v1',
  protocolBaseUrls: {
    'openai-embed':  'https://api.jina.ai/v1',
    'cohere-rerank': 'https://api.jina.ai/v1',
  },
  capabilities: ['embed', 'rerank'],
  protocols: {
    embed:  ['openai-embed'],
    rerank: ['cohere-rerank'],
  },
  defaultModels: {
    embed:  ['jina-embeddings-v3', 'jina-embeddings-v2-base-zh'],
    rerank: ['jina-reranker-v2-base-multilingual'],
  },
  iconKey: 'i-lobe-icons:jina',
  iconColor: 'i-lobe-icons:jina-color',
});
