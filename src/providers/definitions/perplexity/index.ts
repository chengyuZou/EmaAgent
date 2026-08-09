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
      transports: [{ protocol: 'openai-llm' }],
      models: { modelsDevId: 'perplexity' },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { modelsDevId: 'perplexity' },
    },
  },
});
