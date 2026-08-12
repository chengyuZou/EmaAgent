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
      protocols: [{ protocol: 'openai-llm' }],
      catalog: { modelsDevId: 'groq' },
    },
    vision: {
      protocols: [{ protocol: 'openai-vision' }],
      catalog: { modelsDevId: 'groq' },
    },
  },
});
