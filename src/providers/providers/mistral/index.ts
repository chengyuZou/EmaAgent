import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'mistral',
  name: 'Mistral',
  branding: { iconId: 'mistral' },
  connection: {
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { modelsDevId: 'mistral' },
    },
    vision: {
      protocols: [{ protocol: 'openai-vision' }],
      catalog: { modelsDevId: 'mistral' },
    },
  },
});
