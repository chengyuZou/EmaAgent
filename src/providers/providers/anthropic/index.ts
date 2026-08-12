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
      protocols: [{ protocol: 'anthropic-llm' }],
      catalog: { modelsDevId: 'anthropic' },
    },
    vision: {
      protocols: [{ protocol: 'anthropic-vision' }],
      catalog: { modelsDevId: 'anthropic' },
    },
  },
});
