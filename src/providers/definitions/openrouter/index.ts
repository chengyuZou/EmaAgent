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
      models: { sources: [{ type: 'models-dev', providerId: 'openrouter' }, { type: 'manual' }] },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { sources: [{ type: 'models-dev', providerId: 'openrouter' }, { type: 'manual' }] },
    },
  },
});
