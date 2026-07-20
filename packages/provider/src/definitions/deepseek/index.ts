import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'deepseek',
  name: 'DeepSeek',
  branding: { iconId: 'deepseek' },
  connection: {
    defaultBaseUrl: 'https://api.deepseek.com',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      transports: [
        { protocol: 'openai-llm' },
        { protocol: 'anthropic-llm', baseUrl: 'https://api.deepseek.com/anthropic' },
      ],
      models: { sources: [{ type: 'models-dev', providerId: 'deepseek' }, { type: 'manual' }] },
    },
  },
});
