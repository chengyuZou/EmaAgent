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
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { modelsDevId: 'fireworks-ai' },
    },
    vision: {
      protocols: [{ protocol: 'openai-vision' }],
      catalog: { modelsDevId: 'fireworks-ai' },
    },
  },
});
