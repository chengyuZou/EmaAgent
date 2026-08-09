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
      transports: [{ protocol: 'openai-llm' }],
      models: { modelsDevId: 'openrouter' },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { modelsDevId: 'openrouter' },
    },
  },
});
