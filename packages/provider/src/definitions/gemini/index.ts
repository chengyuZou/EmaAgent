import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'gemini',
  name: 'Google Gemini',
  branding: { iconId: 'gemini' },
  connection: {
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      transports: [{ protocol: 'gemini-llm' }],
      models: { sources: [{ type: 'models-dev', providerId: 'google' }, { type: 'manual' }] },
    },
    vision: {
      transports: [{ protocol: 'gemini-vision' }],
      models: { sources: [{ type: 'models-dev', providerId: 'google' }, { type: 'manual' }] },
    },
  },
});
