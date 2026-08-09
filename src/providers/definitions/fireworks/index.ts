import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'fireworks',
  name: 'Fireworks AI',
  branding: { iconId: 'fireworks' },
  connection: {
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      transports: [{ protocol: 'openai-llm' }],
      models: { modelsDevId: 'fireworks-ai' },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { modelsDevId: 'fireworks-ai' },
    },
  },
});
