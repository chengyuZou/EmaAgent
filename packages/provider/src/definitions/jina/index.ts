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
      transports: [{ protocol: 'openai-embed' }],
      models: {
        sources: [
          { type: 'static', models: ['jina-embeddings-v3', 'jina-embeddings-v2-base-zh'] },
          { type: 'manual' },
        ],
      },
    },
    rerank: {
      transports: [{ protocol: 'cohere-rerank' }],
      models: {
        sources: [
          { type: 'static', models: ['jina-reranker-v2-base-multilingual'] },
          { type: 'manual' },
        ],
      },
    },
  },
});
