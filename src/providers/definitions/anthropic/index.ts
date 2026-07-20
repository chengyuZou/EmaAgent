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
      models: { sources: [{ type: 'models-dev', providerId: 'anthropic' }, { type: 'manual' }] },
    },
    vision: {
      transports: [{ protocol: 'anthropic-vision' }],
      models: { sources: [{ type: 'models-dev', providerId: 'anthropic' }, { type: 'manual' }] },
    },
  },
});
