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
      protocols: [{ protocol: 'gemini-llm' }],
      catalog: { modelsDevId: 'google' },
    },
    vision: {
      protocols: [{ protocol: 'gemini-vision' }],
      catalog: { modelsDevId: 'google' },
    },
  },
});
