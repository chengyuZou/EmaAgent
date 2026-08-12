import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  branding: { iconId: 'openrouter' },
  connection: {
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { modelsDevId: 'openrouter' },
    },
    vision: {
      protocols: [{ protocol: 'openai-vision' }],
      catalog: { modelsDevId: 'openrouter' },
    },
  },
});
