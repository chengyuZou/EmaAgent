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
      transports: [{ protocol: 'openai-llm' }],
      models: { modelsDevId: 'mistral' },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { modelsDevId: 'mistral' },
    },
  },
});
