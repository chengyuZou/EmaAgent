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
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { modelsDevId: 'xai' },
    },
    vision: {
      protocols: [{ protocol: 'openai-vision' }],
      catalog: { modelsDevId: 'xai' },
    },
  },
});
