import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'anthropic',
  name: 'Anthropic',
  branding: { iconId: 'anthropic' },
  connection: {
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      transports: [{ protocol: 'anthropic-llm' }],
      models: { modelsDevId: 'anthropic' },
    },
    vision: {
      transports: [{ protocol: 'anthropic-vision' }],
      models: { modelsDevId: 'anthropic' },
    },
  },
});
