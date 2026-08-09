import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'xai',
  name: 'xAI Grok',
  branding: { iconId: 'xai' },
  connection: {
    defaultBaseUrl: 'https://api.x.ai/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      transports: [{ protocol: 'openai-llm' }],
      models: { modelsDevId: 'xai' },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { modelsDevId: 'xai' },
    },
  },
});
