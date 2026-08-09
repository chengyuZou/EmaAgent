import { defineProvider } from '../../types.js';

export const provider = defineProvider({
  id: 'groq',
  name: 'Groq',
  branding: { iconId: 'groq' },
  connection: {
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    auth: { type: 'bearer', required: true },
  },
  capabilities: {
    llm: {
      transports: [{ protocol: 'openai-llm' }],
      models: { modelsDevId: 'groq' },
    },
    vision: {
      transports: [{ protocol: 'openai-vision' }],
      models: { modelsDevId: 'groq' },
    },
  },
});
