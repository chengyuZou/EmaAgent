import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'jina',
  name: 'Jina AI',
  branding: { iconId: 'jina' },
  connection: {
    defaultBaseUrl: 'https://api.jina.ai/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    embed: {
      protocols: [{ protocol: 'openai-embed' }],
      catalog: { staticModels: ['jina-embeddings-v3', 'jina-embeddings-v2-base-zh'] },
    },
    rerank: {
      protocols: [{ protocol: 'cohere-rerank' }],
      catalog: { staticModels: ['jina-reranker-v2-base-multilingual'] },
    },
  },
});
