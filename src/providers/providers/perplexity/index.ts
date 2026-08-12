import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'perplexity',
  name: 'Perplexity',
  branding: { iconId: 'perplexity' },
  connection: {
    defaultBaseUrl: 'https://api.perplexity.ai',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { modelsDevId: 'perplexity' },
    },
    vision: {
      protocols: [{ protocol: 'openai-vision' }],
      catalog: { modelsDevId: 'perplexity' },
    },
  },
});
